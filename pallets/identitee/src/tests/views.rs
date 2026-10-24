use crate::{
	mock::*,
	types::{
		commitment, Capabilities, Fact, FactKind, FieldKey, FieldKind, FieldValue,
		ImportedJudgements, JudgementLevel, Method, MigrationPayload, Name, Note, ReasonCode,
		SourceChain, SubLabel, TrustLevel, Value, Verdict,
	},
	views::{ImportedView, NameStatus},
	FieldAttestations, Identities, Quarantine,
};
use codec::Encode;
use frame_support::assert_ok;
use sp_core::H256;

const USER: u64 = 1;
const SUB: u64 = 3;
const PROPOSED: u64 = 4;
/// Agent of authority 0 ("Alpha") with every capability.
const AGENT: u64 = 10;
/// Agent of authority 1 ("Beta") attesting fields.
const OTHER_AGENT: u64 = 11;

const EMAIL: FieldKey = FieldKey::Typed(FieldKind::Email);
const GITHUB: FieldKey = FieldKey::Typed(FieldKind::GitHub);

fn ext() -> sp_io::TestExternalities {
	new_test_ext_with(crate::GenesisConfig::<Test> {
		authorities: vec![
			authority("Alpha", &[(AGENT, Capabilities::ALL.bits())]),
			authority("Beta", &[(OTHER_AGENT, Capabilities::ATTEST_FIELDS.bits())]),
		],
	})
}

fn value(bytes: &[u8]) -> Value {
	Value::try_from(bytes.to_vec()).unwrap()
}

fn name(text: &str) -> Name {
	Name::try_from(text.as_bytes().to_vec()).unwrap()
}

fn set(who: u64, key: FieldKey, v: &[u8]) {
	assert_ok!(Identitee::set_field(RuntimeOrigin::signed(who), key, FieldValue::Public(value(v))));
}

fn judge(agent: u64, who: u64, key: FieldKey, v: &[u8], verdict: Verdict) {
	assert_ok!(Identitee::provide_judgement(
		RuntimeOrigin::signed(agent),
		who,
		key,
		commitment(&FieldValue::Public(value(v))),
		verdict,
		Method::EmailCode,
		None,
	));
}

fn label(text: &str) -> SubLabel {
	SubLabel::try_from(text.as_bytes().to_vec()).unwrap()
}

fn grant(who: u64, kind: FactKind) {
	assert_ok!(Identitee::grant_fact(
		RuntimeOrigin::signed(AGENT),
		who,
		kind,
		None,
		ReasonCode::Unspecified,
		Note::default(),
	));
}

#[test]
fn no_profile_without_identity() {
	ext().execute_with(|| {
		assert_eq!(Identitee::profile(&USER), None);
		// Facts outlive the identity, but make no profile on their own.
		set(USER, EMAIL, b"a@x.org");
		grant(USER, FactKind::DocumentChecked);
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert_eq!(Identitee::profile(&USER), None);
		assert_eq!(Identitee::trust_level_of(&USER), None);
	});
}

#[test]
fn profile_shows_everything_public_with_its_validity() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		set(USER, GITHUB, b"alice");
		judge(AGENT, USER, EMAIL, b"a@x.org", Verdict::Verified);
		judge(OTHER_AGENT, USER, GITHUB, b"alice", Verdict::Verified);
		// The GitHub value changes: Beta's attestation stays, invalid.
		set(USER, GITHUB, b"alice2");
		grant(USER, FactKind::DocumentChecked);
		grant(USER, FactKind::Fraud);
		assert_ok!(Identitee::revoke_fact(
			RuntimeOrigin::signed(AGENT),
			USER,
			FactKind::Fraud,
			ReasonCode::Other
		));
		assert_ok!(Identitee::claim_username(RuntimeOrigin::signed(USER), name("alice")));
		// One accepted sub and one pending proposal.
		assert_ok!(Identitee::add_sub(RuntimeOrigin::signed(USER), SUB, label("laptop")));
		assert_ok!(Identitee::accept_sub(RuntimeOrigin::signed(SUB), USER));
		assert_ok!(Identitee::add_sub(RuntimeOrigin::signed(USER), PROPOSED, label("phone")));

		let profile = Identitee::profile(&USER).expect("identity exists");
		assert_eq!(profile.identity, Identities::<Test>::get(USER).unwrap());
		assert_eq!(profile.name, Some(b"alice".to_vec()));
		assert_eq!(profile.trust_level, TrustLevel::PartiallyVerified);
		assert_eq!(Some(profile.trust_level), Identitee::trust_level_of(&USER));

		let mut attestations: Vec<_> = profile
			.attestations
			.iter()
			.map(|(key, authority, att, valid)| (key.clone(), *authority, att.verdict, *valid))
			.collect();
		attestations.sort_by_key(|(_, authority, ..)| *authority);
		assert_eq!(
			attestations,
			vec![(EMAIL, 0, Verdict::Verified, true), (GITHUB, 1, Verdict::Verified, false)]
		);
		let email = &profile.attestations.iter().find(|(key, ..)| *key == EMAIL).unwrap().2;
		assert_eq!(Some(email), FieldAttestations::<Test>::get((USER, EMAIL, 0)).as_ref());

		let mut facts: Vec<_> = profile
			.facts
			.iter()
			.map(|(kind, authority, _, active)| (*kind, *authority, *active))
			.collect();
		facts.sort();
		assert_eq!(facts, vec![(FactKind::DocumentChecked, 0, true), (FactKind::Fraud, 0, false)]);
		let fraud: &Fact<u64> =
			&profile.facts.iter().find(|(kind, ..)| *kind == FactKind::Fraud).unwrap().2;
		assert_eq!(fraud.revoked, Some((1, ReasonCode::Other)));

		assert_eq!(profile.parent, None);
		assert_eq!(profile.subs, vec![(SUB, b"laptop".to_vec())]);
		assert_eq!(profile.imported, None);
	});
}

#[test]
fn profile_of_a_sub_names_its_parent() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		set(SUB, EMAIL, b"s@x.org");
		assert_ok!(Identitee::add_sub(RuntimeOrigin::signed(USER), SUB, label("laptop")));
		// A proposal is no membership.
		assert_eq!(Identitee::profile(&SUB).unwrap().parent, None);
		assert_ok!(Identitee::accept_sub(RuntimeOrigin::signed(SUB), USER));
		assert_eq!(Identitee::profile(&SUB).unwrap().parent, Some((USER, b"laptop".to_vec())));
	});
}

#[test]
fn profile_trust_level_matches_the_rule() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		let level = || Identitee::profile(&USER).unwrap().trust_level;
		assert_eq!(level(), TrustLevel::Declared);
		judge(AGENT, USER, EMAIL, b"a@x.org", Verdict::Verified);
		assert_eq!(level(), TrustLevel::FullyVerified);
		grant(USER, FactKind::DocumentChecked);
		assert_eq!(level(), TrustLevel::Certified);
		// A valid rejection from another authority takes the field out.
		judge(OTHER_AGENT, USER, EMAIL, b"a@x.org", Verdict::Rejected);
		assert_eq!(level(), TrustLevel::Declared);
		grant(USER, FactKind::Fraud);
		assert_eq!(level(), TrustLevel::Fraudulent);
		assert_eq!(Some(level()), Identitee::trust_level_of(&USER));
	});
}

#[test]
fn profile_shows_the_migration_history() {
	ext().execute_with(|| {
		assert_ok!(Identitee::request_migration(RuntimeOrigin::signed(USER), SourceChain::Kusama));
		let judgements = vec![
			(7, JudgementLevel::FeePaid),
			(6, JudgementLevel::Reasonable),
			(1, JudgementLevel::Erroneous),
		];
		let payload = MigrationPayload {
			typed: vec![(FieldKind::Email, value(b"a@x.org"))].try_into().unwrap(),
			custom: Default::default(),
			judgements: ImportedJudgements::try_from(judgements.clone()).unwrap(),
		};
		let hash = H256::repeat_byte(7);
		assert_ok!(Identitee::fulfil_migration(
			RuntimeOrigin::signed(AGENT),
			USER,
			SourceChain::Kusama,
			42,
			hash,
			payload
		));
		let profile = Identitee::profile(&USER).unwrap();
		assert_eq!(
			profile.imported,
			Some(ImportedView {
				source: SourceChain::Kusama,
				block: 42,
				block_hash: hash,
				judgements
			})
		);
		assert_eq!(profile.trust_level, TrustLevel::FullyVerified);
	});
}

#[test]
fn name_status_says_why_a_name_cannot_be_claimed() {
	ext().execute_with(|| {
		for invalid in [&b"ab"[..], b"Alice", b"a b", &[b'a'; 33], b""] {
			assert_eq!(Identitee::name_status(invalid), NameStatus::Invalid, "{invalid:?}");
		}
		assert_eq!(Identitee::name_status(&[b'a'; 32]), NameStatus::Available);
		assert_eq!(Identitee::name_status(b"alice"), NameStatus::Available);

		set(USER, EMAIL, b"a@x.org");
		judge(AGENT, USER, EMAIL, b"a@x.org", Verdict::Verified);
		assert_ok!(Identitee::claim_username(RuntimeOrigin::signed(USER), name("alice")));
		assert_eq!(Identitee::name_status(b"alice"), NameStatus::Taken(USER));
		assert_eq!(Identitee::resolve_name(b"alice"), Some(USER));
		assert_eq!(Identitee::resolve_name(b"bob"), None);
		assert_eq!(Identitee::resolve_name(&[b'a'; 40]), None);

		assert_ok!(Identitee::reserve_username(RuntimeOrigin::signed(AGENT), name("polkadot")));
		assert_eq!(Identitee::name_status(b"polkadot"), NameStatus::Reserved);

		assert_ok!(Identitee::release_username(RuntimeOrigin::signed(USER)));
		let until = 1 + NAME_QUARANTINE_BLOCKS;
		assert_eq!(Identitee::name_status(b"alice"), NameStatus::Quarantined { until });
		System::set_block_number(until - 1);
		assert_eq!(Identitee::name_status(b"alice"), NameStatus::Quarantined { until });
		// From `until` on the name is free, though its entry is only removed by the next claim.
		System::set_block_number(until);
		assert!(Quarantine::<Test>::contains_key(name("alice")));
		assert_eq!(Identitee::name_status(b"alice"), NameStatus::Available);
	});
}

#[test]
fn scale_variant_order_is_pinned() {
	// Clients decode these by index: reordering a variant breaks them.
	use TrustLevel::*;
	for (level, index) in [
		(Fraudulent, 0u8),
		(Declared, 1),
		(PartiallyVerified, 2),
		(FullyVerified, 3),
		(Certified, 4),
	] {
		assert_eq!(level.encode(), vec![index], "{level:?}");
	}
	type Status = NameStatus<u64, u32>;
	assert_eq!(Status::Invalid.encode(), vec![0]);
	assert_eq!(Status::Taken(5).encode(), [&[1u8][..], &5u64.encode()].concat());
	assert_eq!(Status::Reserved.encode(), vec![2]);
	assert_eq!(Status::Quarantined { until: 9 }.encode(), [&[3u8][..], &9u32.encode()].concat());
	assert_eq!(Status::Available.encode(), vec![4]);
}
