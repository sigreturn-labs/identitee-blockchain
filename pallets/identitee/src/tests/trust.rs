use crate::{
	mock::*,
	trust::trust_level,
	types::{
		commitment, link_commitment, Capabilities, CustomKey, FactKind, FieldKey, FieldKind,
		FieldValue, Identity, LinkTitle, Method, Note, ReasonCode, TrustLevel, Value, Verdict,
	},
};
use frame_support::assert_ok;
use sp_core::H256;
use sp_runtime::DispatchResult;

/// The identity owner.
const USER: u64 = 1;
/// Agent of authority 0 ("Alpha") holding ATTEST_FIELDS.
const ATTESTER: u64 = 10;
/// Agent of authority 0 holding PERSON_FACTS.
const FACTS_AGENT: u64 = 11;
/// Agent of authority 1 ("Beta") holding ATTEST_FIELDS.
const OTHER_ATTESTER: u64 = 12;

const EMAIL: FieldKey = FieldKey::Typed(FieldKind::Email);
const GITHUB: FieldKey = FieldKey::Typed(FieldKind::GitHub);
const MATRIX: FieldKey = FieldKey::Typed(FieldKind::Matrix);
const DISPLAY_NAME: FieldKey = FieldKey::Typed(FieldKind::DisplayName);

fn ext() -> sp_io::TestExternalities {
	let attest = Capabilities::ATTEST_FIELDS.bits();
	new_test_ext_with(crate::GenesisConfig::<Test> {
		authorities: vec![
			authority(
				"Alpha",
				&[(ATTESTER, attest), (FACTS_AGENT, Capabilities::PERSON_FACTS.bits())],
			),
			authority("Beta", &[(OTHER_ATTESTER, attest)]),
		],
	})
}

fn value(bytes: &[u8]) -> Value {
	Value::try_from(bytes.to_vec()).unwrap()
}

fn custom(key: &[u8]) -> FieldKey {
	FieldKey::Custom(CustomKey::try_from(key.to_vec()).unwrap())
}

fn public(bytes: &[u8]) -> FieldValue {
	FieldValue::Public(value(bytes))
}

fn level() -> Option<TrustLevel> {
	Identitee::trust_level_of(&USER)
}

fn set(key: FieldKey, v: &[u8]) {
	assert_ok!(Identitee::set_field(RuntimeOrigin::signed(USER), key, public(v)));
}

fn attest_with(
	agent: u64,
	key: FieldKey,
	expected: H256,
	verdict: Verdict,
	expires_at: Option<u64>,
) -> DispatchResult {
	Identitee::provide_judgement(
		RuntimeOrigin::signed(agent),
		USER,
		key,
		expected,
		verdict,
		Method::EmailCode,
		expires_at,
	)
}

/// `agent` gives `verdict` on the public value `v` of `key`.
fn judge(agent: u64, key: FieldKey, v: &[u8], verdict: Verdict) {
	assert_ok!(attest_with(agent, key, commitment(&public(v)), verdict, None));
}

/// Alpha verifies the public value `v` of `key`.
fn verify(key: FieldKey, v: &[u8]) {
	judge(ATTESTER, key, v, Verdict::Verified);
}

/// Sets the public value `v` of `key` and has Alpha verify it.
fn set_and_verify(key: FieldKey, v: &[u8]) {
	set(key.clone(), v);
	verify(key, v);
}

fn grant(kind: FactKind, expires_at: Option<u64>) {
	assert_ok!(Identitee::grant_fact(
		RuntimeOrigin::signed(FACTS_AGENT),
		USER,
		kind,
		expires_at,
		ReasonCode::Unspecified,
		Note::try_from(b"checked".to_vec()).unwrap(),
	));
}

fn revoke_fact(kind: FactKind) {
	assert_ok!(Identitee::revoke_fact(
		RuntimeOrigin::signed(FACTS_AGENT),
		USER,
		kind,
		ReasonCode::UserRequest
	));
}

fn revoke_attestation(agent: u64, key: FieldKey) {
	assert_ok!(Identitee::revoke_attestation(
		RuntimeOrigin::signed(agent),
		USER,
		key,
		ReasonCode::UserRequest
	));
}

/// Email and GitHub verified: the identity is fully verified.
fn fully_verified() {
	set_and_verify(EMAIL, b"a@x.org");
	set_and_verify(GITHUB, b"octo");
	assert_eq!(level(), Some(TrustLevel::FullyVerified));
}

// --- The rule through the pallet ---

#[test]
fn no_identity_has_no_level() {
	ext().execute_with(|| {
		assert_eq!(level(), None);
	});
}

#[test]
fn declared_when_nothing_attested() {
	ext().execute_with(|| {
		set(EMAIL, b"a@x.org");
		set(DISPLAY_NAME, b"Ada");
		assert_eq!(level(), Some(TrustLevel::Declared));

		// A bare identity with no field at all is declared too.
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert_ok!(Identitee::set_bio(
			RuntimeOrigin::signed(USER),
			b"hello".to_vec().try_into().unwrap()
		));
		assert_eq!(level(), Some(TrustLevel::Declared));
	});
}

#[test]
fn partial_with_one_verified() {
	ext().execute_with(|| {
		set(EMAIL, b"a@x.org");
		set(GITHUB, b"octo");
		verify(EMAIL, b"a@x.org");
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));
	});
}

#[test]
fn full_when_all_verifiable_verified() {
	ext().execute_with(|| {
		set(EMAIL, b"a@x.org");
		set(GITHUB, b"octo");
		verify(EMAIL, b"a@x.org");
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));
		verify(GITHUB, b"octo");
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
	});
}

#[test]
fn names_are_not_verifiable_fields() {
	ext().execute_with(|| {
		set(DISPLAY_NAME, b"Ada");
		set(FieldKey::Typed(FieldKind::LegalName), b"Ada Lovelace");
		set_and_verify(EMAIL, b"a@x.org");
		// Only the email counts for the "all verifiable fields" rule.
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
	});
}

#[test]
fn bio_links_custom_do_not_block_full() {
	ext().execute_with(|| {
		fully_verified();
		assert_ok!(Identitee::set_bio(
			RuntimeOrigin::signed(USER),
			b"hello".to_vec().try_into().unwrap()
		));
		set(custom(b"mastodon"), b"@ada@x.social");
		assert_ok!(Identitee::add_link(
			RuntimeOrigin::signed(USER),
			LinkTitle::try_from(b"home".to_vec()).unwrap(),
			value(b"https://ada.example")
		));
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
	});
}

#[test]
fn custom_or_link_verified_alone_is_only_partial() {
	ext().execute_with(|| {
		// A verified custom field counts for Partial but is not a verifiable typed field.
		set_and_verify(custom(b"mastodon"), b"@ada@x.social");
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));

		// Same for a link.
		let title = LinkTitle::try_from(b"home".to_vec()).unwrap();
		let url = value(b"https://ada.example");
		assert_ok!(Identitee::add_link(RuntimeOrigin::signed(USER), title.clone(), url.clone()));
		assert_ok!(attest_with(
			ATTESTER,
			FieldKey::Link(0),
			link_commitment(&title, &url),
			Verdict::Verified,
			None
		));
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));

		// An unverified verifiable field next to it changes nothing for Partial.
		set(EMAIL, b"a@x.org");
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));
	});
}

#[test]
fn new_unverified_field_drops_to_partial() {
	ext().execute_with(|| {
		fully_verified();
		set(MATRIX, b"@ada:x.org");
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));

		// Verifying it, or removing it, restores the level.
		verify(MATRIX, b"@ada:x.org");
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
		set(FieldKey::Typed(FieldKind::Telegram), b"ada");
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));
		assert_ok!(Identitee::clear_field(
			RuntimeOrigin::signed(USER),
			FieldKey::Typed(FieldKind::Telegram)
		));
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
	});
}

#[test]
fn modified_field_loses_its_verification() {
	ext().execute_with(|| {
		fully_verified();
		set(EMAIL, b"b@x.org");
		// The attestation of the old value is stale: the email is unverified again.
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));
		set(GITHUB, b"other");
		assert_eq!(level(), Some(TrustLevel::Declared));
		// Setting the attested values back makes the attestations valid again.
		set(EMAIL, b"a@x.org");
		set(GITHUB, b"octo");
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
	});
}

#[test]
fn rejected_field_blocks_full() {
	ext().execute_with(|| {
		set_and_verify(EMAIL, b"a@x.org");
		set(GITHUB, b"octo");
		// Alpha verified GitHub, Beta checked the same value and rejected it.
		verify(GITHUB, b"octo");
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
		judge(OTHER_ATTESTER, GITHUB, b"octo", Verdict::Rejected);
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));

		// Once the rejection is revoked the field is verified again.
		revoke_attestation(OTHER_ATTESTER, GITHUB);
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
	});
}

#[test]
fn rejected_alone_counts_as_not_verified() {
	ext().execute_with(|| {
		set(EMAIL, b"a@x.org");
		judge(ATTESTER, EMAIL, b"a@x.org", Verdict::Rejected);
		assert_eq!(level(), Some(TrustLevel::Declared));

		// A rejected field blocks Full even when another one is verified.
		set_and_verify(GITHUB, b"octo");
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));
	});
}

#[test]
fn verified_and_rejected_field_is_not_verified_for_partial_either() {
	ext().execute_with(|| {
		// Alpha verified the email, Beta checked the same value and rejected it: a
		// rejected field counts as not verified, so nothing is verified.
		set(EMAIL, b"a@x.org");
		verify(EMAIL, b"a@x.org");
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
		judge(OTHER_ATTESTER, EMAIL, b"a@x.org", Verdict::Rejected);
		assert_eq!(level(), Some(TrustLevel::Declared));

		// Revoking the rejection gives the verification back.
		revoke_attestation(OTHER_ATTESTER, EMAIL);
		assert_eq!(level(), Some(TrustLevel::FullyVerified));

		// The same holds for the fields that only ever count for Partial.
		set(custom(b"mastodon"), b"@ada@x.social");
		verify(custom(b"mastodon"), b"@ada@x.social");
		judge(OTHER_ATTESTER, custom(b"mastodon"), b"@ada@x.social", Verdict::Rejected);
		assert_ok!(Identitee::clear_field(RuntimeOrigin::signed(USER), EMAIL));
		assert_eq!(level(), Some(TrustLevel::Declared));
	});
}

#[test]
fn one_valid_verification_is_enough_among_authorities() {
	ext().execute_with(|| {
		set(EMAIL, b"a@x.org");
		judge(ATTESTER, EMAIL, b"a@x.org", Verdict::Verified);
		// A second authority also verified it; losing one of them keeps the field verified.
		judge(OTHER_ATTESTER, EMAIL, b"a@x.org", Verdict::Verified);
		revoke_attestation(ATTESTER, EMAIL);
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
		revoke_attestation(OTHER_ATTESTER, EMAIL);
		assert_eq!(level(), Some(TrustLevel::Declared));
	});
}

#[test]
fn expired_or_revoked_attestation_does_not_count() {
	ext().execute_with(|| {
		set(EMAIL, b"a@x.org");
		let now = System::block_number();
		assert_ok!(attest_with(
			ATTESTER,
			EMAIL,
			commitment(&public(b"a@x.org")),
			Verdict::Verified,
			Some(now + 10)
		));
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
		System::set_block_number(now + 10);
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
		System::set_block_number(now + 11);
		assert_eq!(level(), Some(TrustLevel::Declared));

		verify(EMAIL, b"a@x.org");
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
		revoke_attestation(ATTESTER, EMAIL);
		assert_eq!(level(), Some(TrustLevel::Declared));
	});
}

#[test]
fn certified_needs_full_and_document() {
	ext().execute_with(|| {
		fully_verified();
		grant(FactKind::DocumentChecked, None);
		assert_eq!(level(), Some(TrustLevel::Certified));

		// A new unverified field takes the badge away, the document fact stays.
		set(MATRIX, b"@ada:x.org");
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));
		verify(MATRIX, b"@ada:x.org");
		assert_eq!(level(), Some(TrustLevel::Certified));

		// A revoked document fact no longer promotes.
		revoke_fact(FactKind::DocumentChecked);
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
	});
}

#[test]
fn expired_document_fact_does_not_certify() {
	ext().execute_with(|| {
		fully_verified();
		let now = System::block_number();
		grant(FactKind::DocumentChecked, Some(now + 5));
		assert_eq!(level(), Some(TrustLevel::Certified));
		System::set_block_number(now + 5);
		assert_eq!(level(), Some(TrustLevel::Certified));
		System::set_block_number(now + 6);
		assert_eq!(level(), Some(TrustLevel::FullyVerified));
	});
}

#[test]
fn document_alone_is_not_certified() {
	ext().execute_with(|| {
		set(EMAIL, b"a@x.org");
		grant(FactKind::DocumentChecked, None);
		assert_eq!(level(), Some(TrustLevel::Declared));

		// Partially verified is not enough either.
		set(GITHUB, b"octo");
		verify(EMAIL, b"a@x.org");
		assert_eq!(level(), Some(TrustLevel::PartiallyVerified));
	});
}

#[test]
fn fraud_overrides_certified() {
	ext().execute_with(|| {
		fully_verified();
		grant(FactKind::DocumentChecked, None);
		assert_eq!(level(), Some(TrustLevel::Certified));
		grant(FactKind::Fraud, None);
		assert_eq!(level(), Some(TrustLevel::Fraudulent));

		// Revoking the finding gives the earned level back.
		revoke_fact(FactKind::Fraud);
		assert_eq!(level(), Some(TrustLevel::Certified));
	});
}

#[test]
fn fraud_overrides_a_bare_identity() {
	ext().execute_with(|| {
		set(DISPLAY_NAME, b"Ada");
		grant(FactKind::Fraud, None);
		assert_eq!(level(), Some(TrustLevel::Fraudulent));
	});
}

#[test]
fn expired_fraud_no_longer_counts() {
	ext().execute_with(|| {
		fully_verified();
		grant(FactKind::DocumentChecked, None);
		let now = System::block_number();
		grant(FactKind::Fraud, Some(now + 20));
		assert_eq!(level(), Some(TrustLevel::Fraudulent));
		// Active up to and including its last block.
		System::set_block_number(now + 20);
		assert_eq!(level(), Some(TrustLevel::Fraudulent));
		System::set_block_number(now + 21);
		assert_eq!(level(), Some(TrustLevel::Certified));
	});
}

#[test]
fn fraud_survives_clear_identity_but_no_identity_has_no_level() {
	ext().execute_with(|| {
		set(EMAIL, b"a@x.org");
		grant(FactKind::Fraud, None);
		assert_eq!(level(), Some(TrustLevel::Fraudulent));

		// Clearing the identity leaves no level at all, whatever facts remain.
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert_eq!(level(), None);

		// The finding comes back with the recreated identity.
		set(DISPLAY_NAME, b"Fresh start");
		assert_eq!(level(), Some(TrustLevel::Fraudulent));

		// Only Root's purge removes it.
		assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), USER));
		assert_eq!(level(), None);
		set(DISPLAY_NAME, b"Fresh start");
		assert_eq!(level(), Some(TrustLevel::Declared));
	});
}

// --- The pure rule ---

fn identity_with(kinds: &[FieldKind]) -> Identity<u64> {
	let mut identity = Identity::<u64>::new(1);
	for kind in kinds {
		identity.typed.try_insert(*kind, public(b"v")).unwrap();
	}
	identity
}

#[test]
fn pure_no_identity_is_none_whatever_the_facts() {
	assert_eq!(trust_level::<u64>(None, &[], &[]), None);
	assert_eq!(trust_level::<u64>(None, &[], &[(FactKind::Fraud, true)]), None);
	assert_eq!(
		trust_level::<u64>(None, &[(EMAIL, true, false)], &[(FactKind::DocumentChecked, true)]),
		None
	);
}

#[test]
fn pure_ignores_inactive_facts() {
	let identity = identity_with(&[FieldKind::Email]);
	let fields = [(EMAIL, true, false)];
	assert_eq!(
		trust_level(
			Some(&identity),
			&fields,
			&[(FactKind::Fraud, false), (FactKind::DocumentChecked, false)]
		),
		Some(TrustLevel::FullyVerified)
	);
	assert_eq!(
		trust_level(
			Some(&identity),
			&fields,
			&[(FactKind::Fraud, false), (FactKind::DocumentChecked, true)]
		),
		Some(TrustLevel::Certified)
	);
}

#[test]
fn pure_flags_of_absent_fields_are_ignored() {
	// A caller cannot make a field count by flagging a key the identity does not have.
	let identity = identity_with(&[FieldKind::Email]);
	let fields =
		[(GITHUB, true, false), (custom(b"gone"), true, false), (FieldKey::Link(3), true, false)];
	assert_eq!(trust_level(Some(&identity), &fields, &[]), Some(TrustLevel::Declared));
}

#[test]
fn pure_missing_flags_count_as_unverified() {
	// GitHub is in the identity but absent from the flags: it blocks Full.
	let identity = identity_with(&[FieldKind::Email, FieldKind::GitHub]);
	assert_eq!(
		trust_level(Some(&identity), &[(EMAIL, true, false)], &[]),
		Some(TrustLevel::PartiallyVerified)
	);
	assert_eq!(trust_level(Some(&identity), &[], &[]), Some(TrustLevel::Declared));
}

#[test]
fn pure_full_needs_a_verifiable_typed_field() {
	// Names and custom fields are not verifiable: all verified, they give Partial, never Full.
	let mut identity = identity_with(&[FieldKind::DisplayName, FieldKind::LegalName]);
	identity
		.custom
		.try_insert(CustomKey::try_from(b"k".to_vec()).unwrap(), public(b"v"))
		.unwrap();
	let fields = [
		(DISPLAY_NAME, true, false),
		(FieldKey::Typed(FieldKind::LegalName), true, false),
		(custom(b"k"), true, false),
	];
	assert_eq!(trust_level(Some(&identity), &fields, &[]), Some(TrustLevel::PartiallyVerified));
	// And with nothing verified they are just declared.
	assert_eq!(trust_level(Some(&identity), &[], &[]), Some(TrustLevel::Declared));
}

#[test]
fn pure_rejected_counts_as_not_verified() {
	let identity = identity_with(&[FieldKind::Email, FieldKind::GitHub]);
	// Email is both verified and rejected: not verified, so it blocks Full and gives no Partial
	// either. GitHub, verified and not rejected, is what keeps the level at Partial.
	let fields = [(EMAIL, true, true), (GITHUB, true, false)];
	assert_eq!(trust_level(Some(&identity), &fields, &[]), Some(TrustLevel::PartiallyVerified));
	// With nothing else verified the identity is only declared.
	let fields = [(EMAIL, true, true)];
	let identity = identity_with(&[FieldKind::Email]);
	assert_eq!(trust_level(Some(&identity), &fields, &[]), Some(TrustLevel::Declared));
	// A rejection alone is not a verification either.
	let fields = [(EMAIL, false, true)];
	assert_eq!(trust_level(Some(&identity), &fields, &[]), Some(TrustLevel::Declared));
}

#[test]
fn pure_rejected_custom_field_gives_no_partial() {
	let mut identity = identity_with(&[]);
	identity
		.custom
		.try_insert(CustomKey::try_from(b"k".to_vec()).unwrap(), public(b"v"))
		.unwrap();
	assert_eq!(
		trust_level(Some(&identity), &[(custom(b"k"), true, false)], &[]),
		Some(TrustLevel::PartiallyVerified)
	);
	assert_eq!(
		trust_level(Some(&identity), &[(custom(b"k"), true, true)], &[]),
		Some(TrustLevel::Declared)
	);
}

#[test]
fn pure_entries_of_the_same_key_are_folded() {
	// One entry per attestation, as a view listing them gives: a verification and a rejection of
	// the same field from two authorities make it unverified, for Full and Partial alike.
	let identity = identity_with(&[FieldKind::Email]);
	let fields = [(EMAIL, true, false), (EMAIL, false, true)];
	assert_eq!(trust_level(Some(&identity), &fields, &[]), Some(TrustLevel::Declared));
	let identity = identity_with(&[FieldKind::Email, FieldKind::GitHub]);
	let fields = [(EMAIL, true, false), (GITHUB, false, false), (EMAIL, false, true)];
	assert_eq!(trust_level(Some(&identity), &fields, &[]), Some(TrustLevel::Declared));
	// An invalid entry next to a valid verification changes nothing.
	let fields = [(EMAIL, false, false), (EMAIL, true, false), (GITHUB, true, false)];
	assert_eq!(trust_level(Some(&identity), &fields, &[]), Some(TrustLevel::FullyVerified));
	// Facts too: one active entry among inactive ones is enough.
	let facts = [(FactKind::Fraud, false), (FactKind::Fraud, true)];
	assert_eq!(trust_level(Some(&identity), &fields, &facts), Some(TrustLevel::Fraudulent));
}

#[test]
fn pure_fraud_wins_over_everything() {
	let identity = identity_with(&[FieldKind::Email]);
	assert_eq!(
		trust_level(
			Some(&identity),
			&[(EMAIL, true, false)],
			&[(FactKind::DocumentChecked, true), (FactKind::Fraud, true)]
		),
		Some(TrustLevel::Fraudulent)
	);
}
