use crate::{
	limits::MAX_PENDING_REQUESTS,
	mock::*,
	types::{
		commitment, AuthorityId, Capabilities, CustomKey, Fact, FactKind, FieldAttestation,
		FieldKey, FieldKind, FieldValue, LinkTitle, Method, Note, ReasonCode, SourceChain, Target,
		Value, Verdict,
	},
	Error, Event, Facts, FieldAttestations, PendingCount, PendingRequests,
};
use codec::Encode;
use frame_support::{assert_noop, assert_ok, dispatch::CheckIfFeeless};
use sp_core::H256;
use sp_io::hashing::blake2_256;
use sp_runtime::DispatchResult;

/// The identity owner.
const USER: u64 = 1;
/// Agent of authority 0 ("Alpha") holding ATTEST_FIELDS.
const ATTESTER: u64 = 10;
/// Agent of authority 0 holding PERSON_FACTS.
const FACTS_AGENT: u64 = 11;
/// Agent of authority 1 ("Beta") holding ATTEST_FIELDS.
const OTHER_ATTESTER: u64 = 12;
/// Agent of authority 1 holding MIGRATE only.
const MIGRATOR: u64 = 13;

const ALPHA: AuthorityId = 0;
const BETA: AuthorityId = 1;

const EMAIL: FieldKey = FieldKey::Typed(FieldKind::Email);
const GITHUB: FieldKey = FieldKey::Typed(FieldKind::GitHub);

fn ext() -> sp_io::TestExternalities {
	let attest = Capabilities::ATTEST_FIELDS.bits();
	new_test_ext_with(crate::GenesisConfig::<Test> {
		authorities: vec![
			authority(
				"Alpha",
				&[(ATTESTER, attest), (FACTS_AGENT, Capabilities::PERSON_FACTS.bits())],
			),
			authority(
				"Beta",
				&[(OTHER_ATTESTER, attest), (MIGRATOR, Capabilities::MIGRATE.bits())],
			),
		],
	})
}

fn value(bytes: &[u8]) -> Value {
	Value::try_from(bytes.to_vec()).unwrap()
}

fn note(bytes: &[u8]) -> Note {
	Note::try_from(bytes.to_vec()).unwrap()
}

fn hash(bytes: &[u8]) -> H256 {
	H256(blake2_256(bytes))
}

/// Commitment of the public value `v`.
fn public_commit(v: &[u8]) -> H256 {
	commitment(&FieldValue::Public(value(v)))
}

fn set_public(who: u64, key: FieldKey, v: &[u8]) {
	assert_ok!(Identitee::set_field(RuntimeOrigin::signed(who), key, FieldValue::Public(value(v))));
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

/// Attests `key` of `USER` as `Verified` by `agent`, against the public value `v`.
fn attest(agent: u64, key: FieldKey, v: &[u8]) {
	assert_ok!(attest_with(agent, key, public_commit(v), Verdict::Verified, None));
}

fn stored(key: FieldKey, authority: AuthorityId) -> FieldAttestation<u64> {
	FieldAttestations::<Test>::get((USER, key, authority)).expect("attestation stored")
}

fn valid(key: FieldKey, authority: AuthorityId) -> bool {
	let att = stored(key.clone(), authority);
	Identitee::attestation_is_valid(&USER, &key, &att, System::block_number())
}

fn request(authority: AuthorityId, target: Target) -> DispatchResult {
	Identitee::request_judgement(RuntimeOrigin::signed(USER), authority, target)
}

fn grant(agent: u64, kind: FactKind, expires_at: Option<u64>) -> DispatchResult {
	Identitee::grant_fact(
		RuntimeOrigin::signed(agent),
		USER,
		kind,
		expires_at,
		ReasonCode::Unspecified,
		note(b"checked"),
	)
}

fn attestation_count() -> usize {
	FieldAttestations::<Test>::iter().count()
}

#[test]
fn attest_field_rejects_stale_commitment() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		// The agent checked a@x.org, then the user changed the field before the attestation.
		set_public(USER, EMAIL, b"b@x.org");
		assert_noop!(
			attest_with(ATTESTER, EMAIL, public_commit(b"a@x.org"), Verdict::Verified, None),
			Error::<Test>::StaleCommitment
		);
		assert_eq!(attestation_count(), 0);

		// An absent field is a distinct error.
		assert_noop!(
			attest_with(ATTESTER, GITHUB, public_commit(b"a@x.org"), Verdict::Verified, None),
			Error::<Test>::FieldNotFound
		);
		// Against the current value it works.
		attest(ATTESTER, EMAIL, b"b@x.org");
		assert_eq!(attestation_count(), 1);
	});
}

#[test]
fn attestation_invalid_after_field_change_only_that_one() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		set_public(USER, GITHUB, b"octo");
		attest(ATTESTER, EMAIL, b"a@x.org");
		attest(ATTESTER, GITHUB, b"octo");
		assert!(valid(EMAIL, ALPHA));
		assert!(valid(GITHUB, ALPHA));

		set_public(USER, EMAIL, b"b@x.org");
		assert!(!valid(EMAIL, ALPHA));
		assert!(valid(GITHUB, ALPHA));
		// Nothing was deleted: the stale attestation is still there, just invalid.
		assert_eq!(attestation_count(), 2);

		// Setting the attested value back makes it valid again.
		set_public(USER, EMAIL, b"a@x.org");
		assert!(valid(EMAIL, ALPHA));
	});
}

#[test]
fn attestation_expires() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		let now = System::block_number();
		assert_ok!(attest_with(
			ATTESTER,
			EMAIL,
			public_commit(b"a@x.org"),
			Verdict::Verified,
			Some(now + 10)
		));
		assert!(valid(EMAIL, ALPHA));
		System::set_block_number(now + 10);
		assert!(valid(EMAIL, ALPHA));
		System::set_block_number(now + 11);
		assert!(!valid(EMAIL, ALPHA));
	});
}

#[test]
fn expiry_must_be_in_the_future() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		let now = System::block_number();
		assert_noop!(
			attest_with(ATTESTER, EMAIL, public_commit(b"a@x.org"), Verdict::Verified, Some(now)),
			Error::<Test>::ExpiryNotInFuture
		);
		set_public(USER, FieldKey::Typed(FieldKind::DisplayName), b"Me");
		assert_noop!(
			grant(FACTS_AGENT, FactKind::Fraud, Some(now)),
			Error::<Test>::ExpiryNotInFuture
		);
		assert_ok!(attest_with(
			ATTESTER,
			EMAIL,
			public_commit(b"a@x.org"),
			Verdict::Verified,
			Some(now + 1)
		));
		assert_ok!(grant(FACTS_AGENT, FactKind::Fraud, Some(now + 1)));
	});
}

#[test]
fn reveal_keeps_attestation_valid() {
	ext().execute_with(|| {
		let salt = [7u8; 32];
		let commit = |v: &[u8]| crate::types::private_commitment(&salt, v);
		// Alpha attested an older private value, Beta the current one.
		let old = commit(b"old@x.org");
		let current = commit(b"me@x.org");
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(USER),
			EMAIL,
			FieldValue::Private(old)
		));
		assert_ok!(attest_with(ATTESTER, EMAIL, old, Verdict::Verified, None));
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(USER),
			EMAIL,
			FieldValue::Private(current)
		));
		assert_ok!(attest_with(OTHER_ATTESTER, EMAIL, current, Verdict::Verified, None));
		assert!(!valid(EMAIL, ALPHA));
		assert!(valid(EMAIL, BETA));

		assert_ok!(Identitee::reveal_field(
			RuntimeOrigin::signed(USER),
			EMAIL,
			value(b"me@x.org"),
			salt
		));
		// The attestation of the revealed value now commits to the public value and stays valid.
		assert!(valid(EMAIL, BETA));
		assert_eq!(stored(EMAIL, BETA).commitment, public_commit(b"me@x.org"));
		// The one of another value is left as it was, and stays invalid.
		assert_eq!(stored(EMAIL, ALPHA).commitment, old);
		assert!(!valid(EMAIL, ALPHA));
	});
}

#[test]
fn attest_consumes_pending_request() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		assert_ok!(request(ALPHA, Target::Field(EMAIL)));
		assert_ok!(request(BETA, Target::Field(EMAIL)));
		assert_eq!(PendingCount::<Test>::get(USER), 2);

		attest(ATTESTER, EMAIL, b"a@x.org");
		assert!(!PendingRequests::<Test>::contains_key(USER, (ALPHA, Target::Field(EMAIL))));
		// The request made to another authority is still pending.
		assert!(PendingRequests::<Test>::contains_key(USER, (BETA, Target::Field(EMAIL))));
		assert_eq!(PendingCount::<Test>::get(USER), 1);

		// Attesting without a request is allowed and leaves the count alone.
		set_public(USER, GITHUB, b"octo");
		attest(ATTESTER, GITHUB, b"octo");
		assert_eq!(PendingCount::<Test>::get(USER), 1);
	});
}

#[test]
fn pending_requests_capped_at_16() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		for id in 0..MAX_PENDING_REQUESTS {
			assert_ok!(request(ALPHA, Target::Field(FieldKey::Link(id))));
		}
		assert_eq!(PendingCount::<Test>::get(USER), MAX_PENDING_REQUESTS);
		assert_noop!(
			request(ALPHA, Target::Field(FieldKey::Link(MAX_PENDING_REQUESTS))),
			Error::<Test>::TooManyRequests
		);
		// Cancelling one makes room again.
		assert_ok!(Identitee::cancel_request(
			RuntimeOrigin::signed(USER),
			ALPHA,
			Target::Field(FieldKey::Link(0))
		));
		assert_ok!(request(ALPHA, Target::Field(FieldKey::Link(MAX_PENDING_REQUESTS))));
	});
}

#[test]
fn request_attestation_checks() {
	ext().execute_with(|| {
		assert_noop!(request(ALPHA, Target::Field(EMAIL)), Error::<Test>::NoIdentity);
		set_public(USER, EMAIL, b"a@x.org");
		assert_noop!(request(7, Target::Field(EMAIL)), Error::<Test>::UnknownAuthority);
		assert_ok!(Identitee::set_authority_active(RuntimeOrigin::root(), BETA, false));
		assert_noop!(request(BETA, Target::Field(EMAIL)), Error::<Test>::AuthorityInactive);

		let now = System::block_number();
		assert_ok!(request(ALPHA, Target::Field(EMAIL)));
		System::assert_last_event(
			Event::AttestationRequested {
				who: USER,
				authority: ALPHA,
				target: Target::Field(EMAIL),
			}
			.into(),
		);
		assert_eq!(PendingRequests::<Test>::get(USER, (ALPHA, Target::Field(EMAIL))), Some(now));
		assert_noop!(request(ALPHA, Target::Field(EMAIL)), Error::<Test>::RequestExists);
		// A fact is a different target.
		assert_ok!(request(ALPHA, Target::Fact(FactKind::DocumentChecked)));
		assert_eq!(PendingCount::<Test>::get(USER), 2);
	});
}

#[test]
fn cancel_request_removes_it() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		assert_ok!(request(ALPHA, Target::Field(EMAIL)));
		assert_ok!(Identitee::cancel_request(
			RuntimeOrigin::signed(USER),
			ALPHA,
			Target::Field(EMAIL)
		));
		System::assert_last_event(
			Event::RequestCancelled { who: USER, authority: ALPHA, target: Target::Field(EMAIL) }
				.into(),
		);
		assert_eq!(PendingCount::<Test>::get(USER), 0);
		assert_eq!(PendingRequests::<Test>::iter().count(), 0);
		assert_noop!(
			Identitee::cancel_request(RuntimeOrigin::signed(USER), ALPHA, Target::Field(EMAIL)),
			Error::<Test>::UnknownRequest
		);
	});
}

#[test]
fn reject_request_by_the_right_agent() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		assert_ok!(request(ALPHA, Target::Field(EMAIL)));
		assert_ok!(request(ALPHA, Target::Fact(FactKind::DocumentChecked)));
		let reject = |agent: u64, target: Target, text: &[u8]| {
			Identitee::reject_request(
				RuntimeOrigin::signed(agent),
				USER,
				target,
				ReasonCode::Disposable,
				note(text),
			)
		};

		// A field request needs ATTEST_FIELDS, a fact request PERSON_FACTS.
		assert_noop!(
			reject(FACTS_AGENT, Target::Field(EMAIL), b""),
			Error::<Test>::MissingCapability
		);
		assert_noop!(
			reject(ATTESTER, Target::Fact(FactKind::DocumentChecked), b""),
			Error::<Test>::MissingCapability
		);
		// Beta's agent sees no request to Beta.
		assert_noop!(
			reject(OTHER_ATTESTER, Target::Field(EMAIL), b""),
			Error::<Test>::UnknownRequest
		);
		assert_noop!(
			reject(ATTESTER, Target::Field(EMAIL), &[0xff, 0xfe]),
			Error::<Test>::InvalidUtf8
		);

		assert_ok!(reject(ATTESTER, Target::Field(EMAIL), b"temporary mailbox"));
		System::assert_last_event(
			Event::RequestRejected {
				who: USER,
				authority: ALPHA,
				target: Target::Field(EMAIL),
				reason: ReasonCode::Disposable,
				note: note(b"temporary mailbox"),
				agent: ATTESTER,
			}
			.into(),
		);
		assert_ok!(reject(FACTS_AGENT, Target::Fact(FactKind::DocumentChecked), b""));
		assert_eq!(PendingCount::<Test>::get(USER), 0);
		assert_eq!(PendingRequests::<Test>::iter().count(), 0);
	});
}

#[test]
fn rejected_verdict_is_stored() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@tempmail.example");
		let now = System::block_number();
		assert_ok!(Identitee::provide_judgement(
			RuntimeOrigin::signed(ATTESTER),
			USER,
			EMAIL,
			public_commit(b"a@tempmail.example"),
			Verdict::Rejected,
			Method::Dns,
			None,
		));
		assert_eq!(
			stored(EMAIL, ALPHA),
			FieldAttestation {
				commitment: public_commit(b"a@tempmail.example"),
				verdict: Verdict::Rejected,
				method: Method::Dns,
				issued_at: now,
				expires_at: None,
				revoked: None,
			}
		);
		System::assert_last_event(
			Event::FieldAttested {
				who: USER,
				key: EMAIL,
				authority: ALPHA,
				verdict: Verdict::Rejected,
				agent: ATTESTER,
			}
			.into(),
		);
	});
}

#[test]
fn reattesting_overwrites() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		attest(ATTESTER, EMAIL, b"a@x.org");
		assert_ok!(Identitee::revoke_attestation(
			RuntimeOrigin::signed(ATTESTER),
			USER,
			EMAIL,
			ReasonCode::Abuse
		));
		set_public(USER, EMAIL, b"b@x.org");
		System::set_block_number(5);
		assert_ok!(Identitee::provide_judgement(
			RuntimeOrigin::signed(ATTESTER),
			USER,
			EMAIL,
			public_commit(b"b@x.org"),
			Verdict::Rejected,
			Method::Manual,
			Some(9),
		));
		assert_eq!(attestation_count(), 1);
		assert_eq!(
			stored(EMAIL, ALPHA),
			FieldAttestation {
				commitment: public_commit(b"b@x.org"),
				verdict: Verdict::Rejected,
				method: Method::Manual,
				issued_at: 5,
				expires_at: Some(9),
				revoked: None,
			}
		);
		// Another authority keeps its own attestation of the same field.
		attest(OTHER_ATTESTER, EMAIL, b"b@x.org");
		assert_eq!(attestation_count(), 2);
	});
}

#[test]
fn revoke_attestation_invalidates_it() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		assert_noop!(
			Identitee::revoke_attestation(
				RuntimeOrigin::signed(ATTESTER),
				USER,
				EMAIL,
				ReasonCode::UserRequest
			),
			Error::<Test>::UnknownAttestation
		);
		attest(ATTESTER, EMAIL, b"a@x.org");
		System::set_block_number(3);
		// Only the agents of the attesting authority can revoke it.
		assert_noop!(
			Identitee::revoke_attestation(
				RuntimeOrigin::signed(OTHER_ATTESTER),
				USER,
				EMAIL,
				ReasonCode::UserRequest
			),
			Error::<Test>::UnknownAttestation
		);
		assert_ok!(Identitee::revoke_attestation(
			RuntimeOrigin::signed(ATTESTER),
			USER,
			EMAIL,
			ReasonCode::UserRequest
		));
		System::assert_last_event(
			Event::AttestationRevoked {
				who: USER,
				key: EMAIL,
				authority: ALPHA,
				reason: ReasonCode::UserRequest,
				agent: ATTESTER,
			}
			.into(),
		);
		assert_eq!(stored(EMAIL, ALPHA).revoked, Some((3, ReasonCode::UserRequest)));
		assert!(!valid(EMAIL, ALPHA));
		assert_noop!(
			Identitee::revoke_attestation(
				RuntimeOrigin::signed(ATTESTER),
				USER,
				EMAIL,
				ReasonCode::Other
			),
			Error::<Test>::AlreadyRevoked
		);
	});
}

#[test]
fn link_attestation_commits_to_title_and_url() {
	ext().execute_with(|| {
		let title = LinkTitle::try_from(b"Blog".to_vec()).unwrap();
		let url = value(b"https://x.org");
		assert_ok!(Identitee::add_link(RuntimeOrigin::signed(USER), title.clone(), url.clone()));
		let key = FieldKey::Link(0);
		// Pinned from the documented formula: blake2_256(tag ‖ SCALE((title, url))).
		let mut preimage = b"identitee:field:link:v1".to_vec();
		preimage.extend_from_slice(&(title, url).encode());
		let expected = hash(&preimage);
		assert_ok!(attest_with(ATTESTER, key.clone(), expected, Verdict::Verified, None));
		assert!(valid(key.clone(), ALPHA));

		// Changing the title alone is a change of the link.
		assert_ok!(Identitee::update_link(
			RuntimeOrigin::signed(USER),
			0,
			LinkTitle::try_from(b"Site".to_vec()).unwrap(),
			value(b"https://x.org"),
		));
		assert!(!valid(key.clone(), ALPHA));

		assert_ok!(Identitee::remove_link(RuntimeOrigin::signed(USER), 0));
		assert_eq!(attestation_count(), 0);
		assert_noop!(
			attest_with(ATTESTER, key, expected, Verdict::Verified, None),
			Error::<Test>::FieldNotFound
		);
	});
}

#[test]
fn custom_field_can_be_attested() {
	ext().execute_with(|| {
		let key = FieldKey::Custom(CustomKey::try_from(b"mastodon".to_vec()).unwrap());
		set_public(USER, key.clone(), b"@me@x.social");
		attest(ATTESTER, key.clone(), b"@me@x.social");
		assert!(valid(key, ALPHA));
	});
}

#[test]
fn migration_method_is_reserved() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		assert_noop!(
			Identitee::provide_judgement(
				RuntimeOrigin::signed(ATTESTER),
				USER,
				EMAIL,
				public_commit(b"a@x.org"),
				Verdict::Verified,
				Method::MigratedFromPeopleChain {
					source: SourceChain::Polkadot,
					registrar: 5,
					block: 100
				},
				None,
			),
			Error::<Test>::MethodReserved
		);
	});
}

#[test]
fn fact_requires_person_facts_capability() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		assert_noop!(grant(ATTESTER, FactKind::Fraud, None), Error::<Test>::MissingCapability);
		assert_noop!(grant(MIGRATOR, FactKind::Fraud, None), Error::<Test>::MissingCapability);
		assert_noop!(grant(USER, FactKind::Fraud, None), Error::<Test>::NotAnAgent);
		// And the facts agent cannot attest fields.
		assert_noop!(
			attest_with(FACTS_AGENT, EMAIL, public_commit(b"a@x.org"), Verdict::Verified, None),
			Error::<Test>::MissingCapability
		);

		let now = System::block_number();
		assert_ok!(grant(FACTS_AGENT, FactKind::DocumentChecked, None));
		System::assert_last_event(
			Event::FactGranted {
				who: USER,
				kind: FactKind::DocumentChecked,
				authority: ALPHA,
				agent: FACTS_AGENT,
			}
			.into(),
		);
		assert_eq!(
			Facts::<Test>::get(USER, (FactKind::DocumentChecked, ALPHA)),
			Some(Fact {
				issued_at: now,
				expires_at: None,
				reason: ReasonCode::Unspecified,
				note: note(b"checked"),
				revoked: None,
			})
		);
	});
}

#[test]
fn grant_fact_checks() {
	ext().execute_with(|| {
		assert_noop!(grant(FACTS_AGENT, FactKind::Fraud, None), Error::<Test>::NoIdentity);
		set_public(USER, EMAIL, b"a@x.org");
		assert_noop!(
			Identitee::grant_fact(
				RuntimeOrigin::signed(FACTS_AGENT),
				USER,
				FactKind::Fraud,
				None,
				ReasonCode::Impersonation,
				note(&[0xff]),
			),
			Error::<Test>::InvalidUtf8
		);
		// A granted fact consumes the matching request.
		assert_ok!(request(ALPHA, Target::Fact(FactKind::DocumentChecked)));
		assert_ok!(grant(FACTS_AGENT, FactKind::DocumentChecked, None));
		assert_eq!(PendingCount::<Test>::get(USER), 0);
		assert_eq!(PendingRequests::<Test>::iter().count(), 0);
	});
}

#[test]
fn facts_expire_and_are_revoked() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		let active = |kind: FactKind| {
			let fact = Facts::<Test>::get(USER, (kind, ALPHA)).unwrap();
			Identitee::fact_is_active(&fact, System::block_number())
		};
		assert_ok!(grant(FACTS_AGENT, FactKind::DocumentChecked, Some(4)));
		assert_ok!(grant(FACTS_AGENT, FactKind::Fraud, None));
		assert!(active(FactKind::DocumentChecked));
		System::set_block_number(4);
		assert!(active(FactKind::DocumentChecked));
		System::set_block_number(5);
		assert!(!active(FactKind::DocumentChecked));

		assert!(active(FactKind::Fraud));
		assert_ok!(Identitee::revoke_fact(
			RuntimeOrigin::signed(FACTS_AGENT),
			USER,
			FactKind::Fraud,
			ReasonCode::Other
		));
		System::assert_last_event(
			Event::FactRevoked {
				who: USER,
				kind: FactKind::Fraud,
				authority: ALPHA,
				reason: ReasonCode::Other,
				agent: FACTS_AGENT,
			}
			.into(),
		);
		assert!(!active(FactKind::Fraud));
		assert_noop!(
			Identitee::revoke_fact(
				RuntimeOrigin::signed(FACTS_AGENT),
				USER,
				FactKind::Fraud,
				ReasonCode::Other
			),
			Error::<Test>::AlreadyRevoked
		);
		assert_noop!(
			Identitee::revoke_fact(
				RuntimeOrigin::signed(ATTESTER),
				USER,
				FactKind::Fraud,
				ReasonCode::Other
			),
			Error::<Test>::MissingCapability
		);
		assert_noop!(
			Identitee::revoke_fact(
				RuntimeOrigin::signed(FACTS_AGENT),
				2,
				FactKind::Fraud,
				ReasonCode::Other
			),
			Error::<Test>::UnknownFact
		);
		// Granting again replaces the revoked fact.
		assert_ok!(grant(FACTS_AGENT, FactKind::Fraud, None));
		assert!(active(FactKind::Fraud));
		assert_eq!(Facts::<Test>::iter().count(), 2);
	});
}

#[test]
fn clear_identity_drops_attestations_and_requests() {
	ext().execute_with(|| {
		const NEIGHBOUR: u64 = 2;
		set_public(NEIGHBOUR, EMAIL, b"n@x.org");
		assert_ok!(Identitee::request_judgement(
			RuntimeOrigin::signed(NEIGHBOUR),
			ALPHA,
			Target::Field(EMAIL)
		));

		set_public(USER, EMAIL, b"a@x.org");
		set_public(USER, GITHUB, b"octo");
		attest(ATTESTER, EMAIL, b"a@x.org");
		attest(OTHER_ATTESTER, EMAIL, b"a@x.org");
		assert_ok!(grant(FACTS_AGENT, FactKind::Fraud, None));
		assert_ok!(request(ALPHA, Target::Field(GITHUB)));
		assert_ok!(request(BETA, Target::Fact(FactKind::DocumentChecked)));

		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert_eq!(FieldAttestations::<Test>::iter_prefix((USER,)).count(), 0);
		// Facts about the person are kept (see facts_survive_clear_identity).
		assert_eq!(Facts::<Test>::iter_prefix(USER).count(), 1);
		assert_eq!(PendingRequests::<Test>::iter_prefix(USER).count(), 0);
		assert!(!PendingCount::<Test>::contains_key(USER));

		// Another account is untouched.
		assert_eq!(PendingCount::<Test>::get(NEIGHBOUR), 1);
		assert_eq!(PendingRequests::<Test>::iter().count(), 1);

		// A new identity starts clean, and so does `kill_identity` for an abusive one.
		set_public(USER, EMAIL, b"a@x.org");
		attest(ATTESTER, EMAIL, b"a@x.org");
		assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), USER));
		assert_eq!(attestation_count(), 0);
	});
}

#[test]
fn agent_calls_are_feeless_only_with_the_capability_they_need() {
	use crate::Call;
	ext().execute_with(|| {
		let attest_call = Call::<Test>::provide_judgement {
			who: USER,
			key: EMAIL,
			expected_commitment: H256::zero(),
			verdict: Verdict::Verified,
			method: Method::Manual,
			expires_at: None,
		};
		let grant_call = Call::<Test>::grant_fact {
			who: USER,
			kind: FactKind::Fraud,
			expires_at: None,
			reason: ReasonCode::Other,
			note: Note::default(),
		};
		let reject = |target: Target| Call::<Test>::reject_request {
			who: USER,
			target,
			reason: ReasonCode::Other,
			note: Note::default(),
		};
		let feeless = |call: &Call<Test>, agent: u64| {
			RuntimeCall::Identitee(call.clone()).is_feeless(&RuntimeOrigin::signed(agent))
		};
		let field = reject(Target::Field(EMAIL));
		let fact = reject(Target::Fact(FactKind::Fraud));

		assert!(feeless(&attest_call, ATTESTER));
		assert!(!feeless(&attest_call, FACTS_AGENT));
		assert!(!feeless(&attest_call, MIGRATOR));
		assert!(!feeless(&attest_call, USER));
		assert!(feeless(&grant_call, FACTS_AGENT));
		assert!(!feeless(&grant_call, ATTESTER));
		assert!(feeless(&field, ATTESTER));
		assert!(!feeless(&field, FACTS_AGENT));
		assert!(feeless(&fact, FACTS_AGENT));
		assert!(!feeless(&fact, ATTESTER));

		// An inactive authority's agents pay.
		assert_ok!(Identitee::set_authority_active(RuntimeOrigin::root(), ALPHA, false));
		assert!(!feeless(&attest_call, ATTESTER));
	});
}

/// Regression, path A: a public value equal to the preimage of an attested private commitment
/// must not inherit the attestation (the user chooses the salt, so the public value would carry
/// an arbitrary prefix under a verified badge).
#[test]
fn public_value_cannot_match_a_private_commitment() {
	ext().execute_with(|| {
		let mut preimage = vec![b's'; 32];
		preimage.extend_from_slice(b"me@x.org");
		// The user may commit to any hash, here blake2_256 of salt ‖ value without a tag.
		let h = hash(&preimage);
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(USER),
			EMAIL,
			FieldValue::Private(h)
		));
		assert_ok!(attest_with(ATTESTER, EMAIL, h, Verdict::Verified, None));
		set_public(USER, EMAIL, &preimage);
		assert!(!valid(EMAIL, ALPHA));
	});
}

/// Regression, path B: an attested public value turned into a private commitment must not be
/// revealable as another value carried by the attestation.
#[test]
fn reveal_cannot_move_an_attestation_to_another_value() {
	ext().execute_with(|| {
		let salt = [b'a'; 32];
		let mut v = salt.to_vec();
		v.extend_from_slice(b"evil");
		set_public(USER, EMAIL, &v);
		let c = commitment(&FieldValue::Public(value(&v)));
		assert_ok!(attest_with(ATTESTER, EMAIL, c, Verdict::Verified, None));
		// Same commitment, now as a private value.
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(USER),
			EMAIL,
			FieldValue::Private(c)
		));
		let revealed =
			Identitee::reveal_field(RuntimeOrigin::signed(USER), EMAIL, value(b"evil"), salt);
		assert!(revealed.is_err());
		assert!(!(revealed.is_ok() && valid(EMAIL, ALPHA)));
	});
}

#[test]
fn facts_survive_clear_identity() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		assert_ok!(grant(FACTS_AGENT, FactKind::Fraud, None));
		assert_ok!(grant(FACTS_AGENT, FactKind::DocumentChecked, None));
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert_ok!(Identitee::set_bio(
			RuntimeOrigin::signed(USER),
			crate::types::Bio::try_from(b"fresh start".to_vec()).unwrap()
		));
		let fraud = Facts::<Test>::get(USER, (FactKind::Fraud, ALPHA)).expect("fact kept");
		assert!(Identitee::fact_is_active(&fraud, System::block_number()));
		assert_eq!(Facts::<Test>::iter_prefix(USER).count(), 2);
	});
}

#[test]
fn revoke_fact_works_without_identity() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		assert_ok!(grant(FACTS_AGENT, FactKind::Fraud, None));
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert_ok!(Identitee::revoke_fact(
			RuntimeOrigin::signed(FACTS_AGENT),
			USER,
			FactKind::Fraud,
			ReasonCode::Other
		));
		let fraud = Facts::<Test>::get(USER, (FactKind::Fraud, ALPHA)).unwrap();
		assert!(!Identitee::fact_is_active(&fraud, System::block_number()));
	});
}

#[test]
fn kill_identity_drops_facts() {
	ext().execute_with(|| {
		set_public(USER, EMAIL, b"a@x.org");
		assert_ok!(grant(FACTS_AGENT, FactKind::Fraud, None));
		assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), USER));
		assert_eq!(Facts::<Test>::iter_prefix(USER).count(), 0);
	});
}

#[test]
fn removing_a_field_or_link_deletes_its_attestations() {
	ext().execute_with(|| {
		let custom = FieldKey::Custom(CustomKey::try_from(b"site".to_vec()).unwrap());
		set_public(USER, EMAIL, b"a@x.org");
		set_public(USER, GITHUB, b"octo");
		set_public(USER, custom.clone(), b"x.org");
		attest(ATTESTER, EMAIL, b"a@x.org");
		attest(OTHER_ATTESTER, EMAIL, b"a@x.org");
		attest(ATTESTER, GITHUB, b"octo");
		attest(ATTESTER, custom.clone(), b"x.org");
		let title = LinkTitle::try_from(b"Blog".to_vec()).unwrap();
		let url = value(b"https://x.org");
		assert_ok!(Identitee::add_link(RuntimeOrigin::signed(USER), title.clone(), url.clone()));
		let link = FieldKey::Link(0);
		let c = Identitee::current_commitment(&USER, &link).unwrap();
		assert_ok!(attest_with(ATTESTER, link.clone(), c, Verdict::Verified, None));
		assert_eq!(attestation_count(), 5);

		assert_ok!(Identitee::clear_field(RuntimeOrigin::signed(USER), EMAIL));
		assert_eq!(FieldAttestations::<Test>::iter_prefix((USER, EMAIL)).count(), 0);
		assert_ok!(Identitee::clear_field(RuntimeOrigin::signed(USER), custom.clone()));
		assert_eq!(FieldAttestations::<Test>::iter_prefix((USER, custom)).count(), 0);
		assert_ok!(Identitee::remove_link(RuntimeOrigin::signed(USER), 0));
		assert_eq!(FieldAttestations::<Test>::iter_prefix((USER, link)).count(), 0);
		// Replacing a value keeps the attestation (it only goes invalid).
		set_public(USER, GITHUB, b"other");
		assert_eq!(attestation_count(), 1);
		assert!(!valid(GITHUB, ALPHA));
	});
}

#[test]
fn private_commitment_follows_the_documented_formula() {
	let salt = [3u8; 32];
	let mut preimage = b"identitee:field:private:v1".to_vec();
	preimage.extend_from_slice(&salt);
	preimage.extend_from_slice(b"me@x.org");
	assert_eq!(crate::types::private_commitment(&salt, b"me@x.org"), hash(&preimage));
	// The three kinds never share a hash for the same bytes.
	assert_ne!(public_commit(b"me@x.org"), hash(b"me@x.org"));
}

#[test]
fn fact_kind_count_matches_the_enum() {
	use codec::Decode;
	let kinds = (0..=u8::MAX).filter(|b| FactKind::decode(&mut &[*b][..]).is_ok()).count();
	assert_eq!(kinds as u32, FactKind::COUNT);
}

#[test]
fn bot_challenge_is_stored() {
	ext().execute_with(|| {
		let telegram = FieldKey::Typed(FieldKind::Telegram);
		set_public(USER, telegram.clone(), b"ada");
		System::set_block_number(3);
		assert_ok!(Identitee::provide_judgement(
			RuntimeOrigin::signed(ATTESTER),
			USER,
			telegram.clone(),
			public_commit(b"ada"),
			Verdict::Verified,
			Method::BotChallenge,
			None,
		));
		assert_eq!(
			stored(telegram.clone(), ALPHA),
			FieldAttestation {
				commitment: public_commit(b"ada"),
				verdict: Verdict::Verified,
				method: Method::BotChallenge,
				issued_at: 3,
				expires_at: None,
				revoked: None,
			}
		);
		assert!(valid(telegram, ALPHA));
	});
}

#[test]
fn method_encoding_is_pinned() {
	// Every method before `BotChallenge` keeps its index; `BotChallenge` comes last.
	let simple = [
		(Method::EmailCode, 0u8),
		(Method::OAuth, 1),
		(Method::MatrixChallenge, 2),
		(Method::PgpSignature, 3),
		(Method::Dns, 4),
		(Method::WebFile, 5),
		(Method::Manual, 6),
	];
	for (method, index) in simple {
		assert_eq!(method.encode(), vec![index], "{method:?}");
	}
	let migrated =
		Method::MigratedFromPeopleChain { source: SourceChain::Kusama, registrar: 2, block: 9 };
	assert_eq!(migrated.encode(), vec![7, 1, 2, 0, 0, 0, 9, 0, 0, 0]);
	assert_eq!(Method::BotChallenge.encode(), vec![8]);
	// Nothing after it.
	use codec::Decode;
	assert!(Method::decode(&mut &[9u8][..]).is_err());
}
