use crate::{
	migration::{dotid_judgement, dotid_registrars, judgement_effect},
	mock::*,
	types::{
		commitment, AuthorityId, Capabilities, CustomKey, Fact, FactKind, FieldAttestation,
		FieldKey, FieldKind, FieldValue, ImportedJudgements, JudgementLevel, Method,
		MigrationPayload, Name, Note, ReasonCode, SourceChain, TrustLevel, Value, Verdict,
	},
	Error, Event, Facts, FieldAttestations, Identities, ImportedHistory, MigrationRequests,
};
use frame_support::{assert_noop, assert_ok, dispatch::CheckIfFeeless};
use sp_core::H256;

/// The person migrating.
const USER: u64 = 1;
/// Agent of authority 1 ("Beta") holding MIGRATE only.
const MIGRATOR: u64 = 13;
/// Agent of authority 0 ("Alpha") holding every capability but MIGRATE.
const ATTESTER: u64 = 10;
/// Agent of authority 0 holding MIGRATE, but its authority gets deactivated in one test.
const ALPHA_MIGRATOR: u64 = 11;
/// Agent of authority 1 ("Beta") that attests fields and records facts: it can revoke what
/// Beta's migration wrote.
const BETA_OFFICER: u64 = 14;

const ALPHA: AuthorityId = 0;
const BETA: AuthorityId = 1;

const BLOCK: u32 = 4_242;
const BLOCK_HASH: H256 = H256::repeat_byte(0xab);

const EMAIL: FieldKey = FieldKey::Typed(FieldKind::Email);
const GITHUB: FieldKey = FieldKey::Typed(FieldKind::GitHub);
const DISPLAY: FieldKey = FieldKey::Typed(FieldKind::DisplayName);

fn ext() -> sp_io::TestExternalities {
	let not_migrate =
		(Capabilities::ATTEST_FIELDS | Capabilities::PERSON_FACTS | Capabilities::MANAGE_NAMES)
			.bits();
	new_test_ext_with(crate::GenesisConfig::<Test> {
		authorities: vec![
			authority(
				"Alpha",
				&[(ATTESTER, not_migrate), (ALPHA_MIGRATOR, Capabilities::MIGRATE.bits())],
			),
			authority(
				"Beta",
				&[(MIGRATOR, Capabilities::MIGRATE.bits()), (BETA_OFFICER, not_migrate)],
			),
		],
	})
}

fn value(bytes: &[u8]) -> Value {
	Value::try_from(bytes.to_vec()).unwrap()
}

fn key(bytes: &[u8]) -> CustomKey {
	CustomKey::try_from(bytes.to_vec()).unwrap()
}

fn judgements(list: &[(u32, JudgementLevel)]) -> ImportedJudgements {
	ImportedJudgements::try_from(list.to_vec()).unwrap()
}

fn payload(
	typed: &[(FieldKind, &[u8])],
	custom: &[(&[u8], &[u8])],
	list: &[(u32, JudgementLevel)],
) -> MigrationPayload {
	MigrationPayload {
		typed: typed
			.iter()
			.map(|(kind, v)| (*kind, value(v)))
			.collect::<Vec<_>>()
			.try_into()
			.unwrap(),
		custom: custom
			.iter()
			.map(|(k, v)| (key(k), value(v)))
			.collect::<Vec<_>>()
			.try_into()
			.unwrap(),
		judgements: judgements(list),
	}
}

/// Email and GitHub (verifiable), a display name and a custom field.
fn full_payload(list: &[(u32, JudgementLevel)]) -> MigrationPayload {
	payload(
		&[
			(FieldKind::DisplayName, b"Ada"),
			(FieldKind::Email, b"ada@x.org"),
			(FieldKind::GitHub, b"ada"),
		],
		&[(b"riot", b"@ada:matrix.org")],
		list,
	)
}

fn request(who: u64, source: SourceChain) -> sp_runtime::DispatchResult {
	Identitee::request_migration(RuntimeOrigin::signed(who), source)
}

fn fulfil_by(
	agent: u64,
	source: SourceChain,
	payload: MigrationPayload,
) -> frame_support::dispatch::DispatchResultWithPostInfo {
	Identitee::fulfil_migration(
		RuntimeOrigin::signed(agent),
		USER,
		source,
		BLOCK,
		BLOCK_HASH,
		payload,
	)
}

fn fulfil(
	source: SourceChain,
	payload: MigrationPayload,
) -> frame_support::dispatch::DispatchResultWithPostInfo {
	fulfil_by(MIGRATOR, source, payload)
}

/// Requests and fulfils a migration of `USER` from `source`.
fn migrate(source: SourceChain, payload: MigrationPayload) {
	assert_ok!(request(USER, source));
	assert_ok!(fulfil(source, payload));
}

fn stored(key: FieldKey) -> FieldAttestation<u64> {
	FieldAttestations::<Test>::get((USER, key, BETA)).expect("attestation stored")
}

fn imported_method(source: SourceChain, registrar: u32) -> Method {
	Method::MigratedFromPeopleChain { source, registrar, block: BLOCK }
}

fn public_commit(v: &[u8]) -> H256 {
	commitment(&FieldValue::Public(value(v)))
}

fn trust() -> Option<TrustLevel> {
	Identitee::trust_level_of(&USER)
}

fn facts() -> Vec<((FactKind, AuthorityId), Fact<u64>)> {
	Facts::<Test>::iter_prefix(USER).collect()
}

// --- requests ---

#[test]
fn request_and_cancel() {
	ext().execute_with(|| {
		assert_ok!(request(USER, SourceChain::Kusama));
		assert_eq!(MigrationRequests::<Test>::get(USER), Some((SourceChain::Kusama, 1)));
		System::assert_last_event(
			Event::MigrationRequested { who: USER, source: SourceChain::Kusama }.into(),
		);
		// One pending request per account.
		assert_noop!(request(USER, SourceChain::Polkadot), Error::<Test>::MigrationRequestExists);

		assert_ok!(Identitee::cancel_migration(RuntimeOrigin::signed(USER)));
		assert!(!MigrationRequests::<Test>::contains_key(USER));
		System::assert_last_event(
			Event::MigrationCancelled { who: USER, source: SourceChain::Kusama }.into(),
		);
		assert_noop!(
			Identitee::cancel_migration(RuntimeOrigin::signed(USER)),
			Error::<Test>::NoMigrationRequest
		);
	});
}

#[test]
fn request_refused_when_identity_exists() {
	ext().execute_with(|| {
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(USER),
			EMAIL,
			FieldValue::Public(value(b"a@x.org"))
		));
		assert_noop!(request(USER, SourceChain::Polkadot), Error::<Test>::IdentityExists);
	});
}

#[test]
fn fulfil_refused_when_identity_created_meanwhile() {
	ext().execute_with(|| {
		assert_ok!(request(USER, SourceChain::Polkadot));
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(USER),
			EMAIL,
			FieldValue::Public(value(b"a@x.org"))
		));
		assert_noop!(
			fulfil(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::Reasonable)])),
			Error::<Test>::IdentityExists
		);
		// The request is still there: the agent can reject it, the user cancel it.
		assert!(MigrationRequests::<Test>::contains_key(USER));
	});
}

#[test]
fn fulfil_without_request_fails() {
	ext().execute_with(|| {
		assert_noop!(
			fulfil(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::Reasonable)])),
			Error::<Test>::NoMigrationRequest
		);
	});
}

#[test]
fn fulfil_twice_fails() {
	ext().execute_with(|| {
		migrate(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::Reasonable)]));
		assert!(!MigrationRequests::<Test>::contains_key(USER));
		assert_noop!(
			fulfil(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::Reasonable)])),
			Error::<Test>::NoMigrationRequest
		);
		// And the migrated identity cannot ask again.
		assert_noop!(request(USER, SourceChain::Polkadot), Error::<Test>::IdentityExists);
	});
}

#[test]
fn fulfil_after_cancel_fails() {
	ext().execute_with(|| {
		assert_ok!(request(USER, SourceChain::Polkadot));
		assert_ok!(Identitee::cancel_migration(RuntimeOrigin::signed(USER)));
		assert_noop!(
			fulfil(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::Reasonable)])),
			Error::<Test>::NoMigrationRequest
		);
		assert!(!Identities::<Test>::contains_key(USER));
	});
}

#[test]
fn fulfil_from_another_source_fails() {
	ext().execute_with(|| {
		assert_ok!(request(USER, SourceChain::Kusama));
		assert_noop!(
			fulfil(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::Reasonable)])),
			Error::<Test>::MigrationSourceMismatch
		);
	});
}

#[test]
fn reject_migration_consumes_the_request() {
	ext().execute_with(|| {
		assert_ok!(request(USER, SourceChain::Kusama));
		assert_noop!(
			Identitee::reject_migration(RuntimeOrigin::signed(ATTESTER), USER, ReasonCode::Other),
			Error::<Test>::MissingCapability
		);
		assert_ok!(Identitee::reject_migration(
			RuntimeOrigin::signed(MIGRATOR),
			USER,
			ReasonCode::ValueMismatch
		));
		assert!(!MigrationRequests::<Test>::contains_key(USER));
		System::assert_last_event(
			Event::MigrationRejected {
				who: USER,
				source: SourceChain::Kusama,
				reason: ReasonCode::ValueMismatch,
				agent: MIGRATOR,
			}
			.into(),
		);
		assert_noop!(
			Identitee::reject_migration(RuntimeOrigin::signed(MIGRATOR), USER, ReasonCode::Other),
			Error::<Test>::NoMigrationRequest
		);
		assert_noop!(
			fulfil(SourceChain::Kusama, full_payload(&[])),
			Error::<Test>::NoMigrationRequest
		);
	});
}

// --- capability ---

#[test]
fn only_migrate_capability_can_fulfil() {
	ext().execute_with(|| {
		assert_ok!(request(USER, SourceChain::Polkadot));
		let p = || full_payload(&[(5, JudgementLevel::Reasonable)]);
		assert_noop!(
			fulfil_by(ATTESTER, SourceChain::Polkadot, p()),
			Error::<Test>::MissingCapability
		);
		assert_noop!(fulfil_by(USER, SourceChain::Polkadot, p()), Error::<Test>::NotAnAgent);
		assert_ok!(Identitee::set_authority_active(RuntimeOrigin::root(), ALPHA, false));
		assert_noop!(
			fulfil_by(ALPHA_MIGRATOR, SourceChain::Polkadot, p()),
			Error::<Test>::AuthorityInactive
		);

		// Feeless for the agent holding MIGRATE only.
		let call = |p| {
			RuntimeCall::Identitee(crate::Call::fulfil_migration {
				who: USER,
				source: SourceChain::Polkadot,
				block: BLOCK,
				block_hash: BLOCK_HASH,
				payload: p,
			})
		};
		assert!(call(p()).is_feeless(&RuntimeOrigin::signed(MIGRATOR)));
		assert!(!call(p()).is_feeless(&RuntimeOrigin::signed(ATTESTER)));
		assert!(!call(p()).is_feeless(&RuntimeOrigin::signed(USER)));
		assert!(!call(p()).is_feeless(&RuntimeOrigin::signed(ALPHA_MIGRATOR)));
		let reject = RuntimeCall::Identitee(crate::Call::reject_migration {
			who: USER,
			reason: ReasonCode::Other,
		});
		assert!(reject.is_feeless(&RuntimeOrigin::signed(MIGRATOR)));
		assert!(!reject.is_feeless(&RuntimeOrigin::signed(ATTESTER)));

		assert_ok!(fulfil_by(MIGRATOR, SourceChain::Polkadot, p()));
	});
}

// --- the import itself ---

#[test]
fn imported_fields_are_public_and_events_name_the_source() {
	ext().execute_with(|| {
		let pgp = [7u8; 20];
		migrate(
			SourceChain::Polkadot,
			payload(
				&[(FieldKind::Email, b"ada@x.org"), (FieldKind::Pgp, &pgp)],
				&[(b"riot", b"@ada:matrix.org")],
				&[],
			),
		);
		let identity = Identities::<Test>::get(USER).expect("identity created");
		assert_eq!(
			identity.typed.get(&FieldKind::Email),
			Some(&FieldValue::Public(value(b"ada@x.org")))
		);
		assert_eq!(identity.typed.get(&FieldKind::Pgp), Some(&FieldValue::Public(value(&pgp))));
		assert_eq!(
			identity.custom.get(&key(b"riot")),
			Some(&FieldValue::Public(value(b"@ada:matrix.org")))
		);
		System::assert_has_event(Event::FieldSet { who: USER, key: EMAIL }.into());
		System::assert_last_event(
			Event::MigrationFulfilled {
				who: USER,
				source: SourceChain::Polkadot,
				block: BLOCK,
				block_hash: BLOCK_HASH,
				agent: MIGRATOR,
			}
			.into(),
		);
	});
}

#[test]
fn reasonable_gives_partially_or_fully_verified() {
	ext().execute_with(|| {
		migrate(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::Reasonable)]));
		// Every imported field, verifiable or not, custom ones included.
		let custom = FieldKey::Custom(key(b"riot"));
		for (field, v) in [
			(EMAIL, &b"ada@x.org"[..]),
			(GITHUB, b"ada"),
			(DISPLAY, b"Ada"),
			(custom, b"@ada:matrix.org"),
		] {
			assert_eq!(
				stored(field.clone()),
				FieldAttestation {
					commitment: public_commit(v),
					verdict: Verdict::Verified,
					method: imported_method(SourceChain::Polkadot, 5),
					issued_at: 1,
					expires_at: None,
					revoked: None,
				}
			);
			System::assert_has_event(
				Event::FieldAttested {
					who: USER,
					key: field,
					authority: BETA,
					verdict: Verdict::Verified,
					agent: MIGRATOR,
				}
				.into(),
			);
		}
		assert_eq!(FieldAttestations::<Test>::iter().count(), 4);
		assert!(facts().is_empty());
		assert_eq!(trust(), Some(TrustLevel::FullyVerified));
	});

	// Only a display name: attested, but not a verifiable field, hence partial.
	ext().execute_with(|| {
		migrate(
			SourceChain::Polkadot,
			payload(&[(FieldKind::DisplayName, b"Ada")], &[], &[(5, JudgementLevel::Reasonable)]),
		);
		assert_eq!(stored(DISPLAY).verdict, Verdict::Verified);
		assert_eq!(trust(), Some(TrustLevel::PartiallyVerified));
	});
}

#[test]
fn knowngood_gives_certified() {
	ext().execute_with(|| {
		migrate(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::KnownGood)]));
		assert_eq!(stored(EMAIL).verdict, Verdict::Verified);
		assert_eq!(stored(GITHUB).verdict, Verdict::Verified);
		assert_eq!(
			facts(),
			vec![(
				(FactKind::DocumentChecked, BETA),
				Fact {
					issued_at: 1,
					expires_at: None,
					reason: ReasonCode::Unspecified,
					note: Note::default(),
					revoked: None,
				}
			)]
		);
		System::assert_has_event(
			Event::FactGranted {
				who: USER,
				kind: FactKind::DocumentChecked,
				authority: BETA,
				agent: MIGRATOR,
			}
			.into(),
		);
		assert_eq!(trust(), Some(TrustLevel::Certified));
	});
}

#[test]
fn lowquality_marks_fields_rejected() {
	ext().execute_with(|| {
		migrate(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::LowQuality)]));
		for field in [EMAIL, GITHUB, DISPLAY, FieldKey::Custom(key(b"riot"))] {
			let att = stored(field);
			assert_eq!(att.verdict, Verdict::Rejected);
			assert_eq!(att.method, imported_method(SourceChain::Polkadot, 5));
		}
		assert!(facts().is_empty());
		assert_eq!(trust(), Some(TrustLevel::Declared));
	});
}

#[test]
fn erroneous_gives_fraudulent() {
	ext().execute_with(|| {
		migrate(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::Erroneous)]));
		assert_eq!(FieldAttestations::<Test>::iter().count(), 0);
		assert_eq!(
			facts(),
			vec![(
				(FactKind::Fraud, BETA),
				Fact {
					issued_at: 1,
					expires_at: None,
					reason: ReasonCode::Unspecified,
					note: Note::default(),
					revoked: None,
				}
			)]
		);
		assert_eq!(trust(), Some(TrustLevel::Fraudulent));
		// The finding outlives the identity, like any fact.
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert_eq!(facts().len(), 1);
	});
}

#[test]
fn other_registrar_is_history_only() {
	let all = [
		(0, JudgementLevel::KnownGood),
		(3, JudgementLevel::Reasonable),
		(9, JudgementLevel::Erroneous),
	];
	ext().execute_with(|| {
		migrate(SourceChain::Polkadot, full_payload(&all));
		assert_eq!(FieldAttestations::<Test>::iter().count(), 0);
		assert!(facts().is_empty());
		assert_eq!(trust(), Some(TrustLevel::Declared));
		assert_eq!(
			ImportedHistory::<Test>::get(USER),
			Some((SourceChain::Polkadot, BLOCK, BLOCK_HASH, judgements(&all)))
		);
	});

	// Polkadot's dotID index means nothing on Kusama.
	ext().execute_with(|| {
		migrate(SourceChain::Kusama, full_payload(&[(5, JudgementLevel::KnownGood)]));
		assert_eq!(FieldAttestations::<Test>::iter().count(), 0);
		assert!(facts().is_empty());
	});

	// dotID judgements that carry no verdict.
	for level in [JudgementLevel::OutOfDate, JudgementLevel::Unknown, JudgementLevel::FeePaid] {
		ext().execute_with(|| {
			migrate(SourceChain::Polkadot, full_payload(&[(5, level)]));
			assert_eq!(FieldAttestations::<Test>::iter().count(), 0);
			assert!(facts().is_empty());
			assert_eq!(trust(), Some(TrustLevel::Declared));
			assert_eq!(
				ImportedHistory::<Test>::get(USER).map(|h| h.3),
				Some(judgements(&[(5, level)]))
			);
		});
	}
}

#[test]
fn kusama_registrar_6_used_when_7_absent() {
	ext().execute_with(|| {
		migrate(
			SourceChain::Kusama,
			full_payload(&[(1, JudgementLevel::LowQuality), (6, JudgementLevel::Reasonable)]),
		);
		assert_eq!(stored(EMAIL).verdict, Verdict::Verified);
		assert_eq!(stored(EMAIL).method, imported_method(SourceChain::Kusama, 6));
	});

	// Both present: 7 wins, wherever it is in the list.
	ext().execute_with(|| {
		migrate(
			SourceChain::Kusama,
			full_payload(&[(6, JudgementLevel::LowQuality), (7, JudgementLevel::Reasonable)]),
		);
		assert_eq!(stored(EMAIL).verdict, Verdict::Verified);
		assert_eq!(stored(EMAIL).method, imported_method(SourceChain::Kusama, 7));
	});
}

#[test]
fn a_level_without_verdict_never_masks_another_dotid_registrar() {
	// #7 only paid a fee (no verdict yet): the verdict of #6 is retained.
	ext().execute_with(|| {
		migrate(
			SourceChain::Kusama,
			full_payload(&[(7, JudgementLevel::FeePaid), (6, JudgementLevel::Reasonable)]),
		);
		assert_eq!(stored(EMAIL).verdict, Verdict::Verified);
		assert_eq!(stored(EMAIL).method, imported_method(SourceChain::Kusama, 6));
	});
	for level in [JudgementLevel::Unknown, JudgementLevel::OutOfDate] {
		assert_eq!(
			dotid_judgement(SourceChain::Kusama, &[(6, JudgementLevel::Erroneous), (7, level)]),
			Some((6, JudgementLevel::Erroneous)),
			"{level:?}"
		);
	}
	// No verdict at all: nothing is retained.
	assert_eq!(
		dotid_judgement(
			SourceChain::Kusama,
			&[(7, JudgementLevel::FeePaid), (6, JudgementLevel::OutOfDate)]
		),
		None
	);
	// A verdict of the preferred registrar still wins.
	assert_eq!(
		dotid_judgement(
			SourceChain::Kusama,
			&[(6, JudgementLevel::Reasonable), (7, JudgementLevel::LowQuality)]
		),
		Some((7, JudgementLevel::LowQuality))
	);
}

#[test]
fn dotid_registrars_and_mapping_table() {
	assert_eq!(dotid_registrars(SourceChain::Polkadot), &[5]);
	assert_eq!(dotid_registrars(SourceChain::Kusama), &[7, 6]);
	use JudgementLevel::*;
	assert_eq!(judgement_effect(Reasonable), (Some(Verdict::Verified), None));
	assert_eq!(
		judgement_effect(KnownGood),
		(Some(Verdict::Verified), Some(FactKind::DocumentChecked))
	);
	assert_eq!(judgement_effect(LowQuality), (Some(Verdict::Rejected), None));
	assert_eq!(judgement_effect(Erroneous), (None, Some(FactKind::Fraud)));
	for level in [OutOfDate, Unknown, FeePaid] {
		assert_eq!(judgement_effect(level), (None, None));
	}
}

#[test]
fn migrated_attestation_lets_the_person_claim_a_name() {
	ext().execute_with(|| {
		migrate(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::Reasonable)]));
		assert_ok!(Identitee::claim_username(
			RuntimeOrigin::signed(USER),
			Name::try_from(b"ada".to_vec()).unwrap()
		));
	});
}

// --- payload checks ---

#[test]
fn invalid_payload_is_refused_whole() {
	let bad: [(MigrationPayload, Error<Test>); 6] = [
		(payload(&[(FieldKind::Email, &[0xff, 0xfe])], &[], &[]), Error::<Test>::InvalidUtf8),
		(payload(&[(FieldKind::Pgp, &[1; 19])], &[], &[]), Error::<Test>::InvalidPgp),
		(payload(&[], &[(&[0xff], b"x")], &[]), Error::<Test>::InvalidUtf8),
		(payload(&[], &[(b"k", &[0xc3])], &[]), Error::<Test>::InvalidUtf8),
		(
			payload(&[(FieldKind::Email, b"a@x.org"), (FieldKind::Email, b"b@x.org")], &[], &[]),
			Error::<Test>::DuplicateField,
		),
		(payload(&[], &[(b"k", b"1"), (b"k", b"2")], &[]), Error::<Test>::DuplicateField),
	];
	for (p, error) in bad {
		ext().execute_with(|| {
			assert_ok!(request(USER, SourceChain::Polkadot));
			// A valid field next to the bad one is not written either.
			let mut p = p;
			p.typed.try_insert(0, (FieldKind::GitHub, value(b"ada"))).unwrap();
			assert_noop!(fulfil(SourceChain::Polkadot, p), error);
		});
	}
	ext().execute_with(|| {
		assert_ok!(request(USER, SourceChain::Polkadot));
		let p = full_payload(&[(5, JudgementLevel::Reasonable), (5, JudgementLevel::Erroneous)]);
		assert_noop!(fulfil(SourceChain::Polkadot, p), Error::<Test>::DuplicateJudgement);
	});
}

#[test]
fn migration_method_cannot_be_forged_by_attest_field() {
	ext().execute_with(|| {
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(USER),
			EMAIL,
			FieldValue::Public(value(b"a@x.org"))
		));
		assert_noop!(
			Identitee::provide_judgement(
				RuntimeOrigin::signed(ATTESTER),
				USER,
				EMAIL,
				public_commit(b"a@x.org"),
				Verdict::Verified,
				imported_method(SourceChain::Polkadot, 5),
				None,
			),
			Error::<Test>::MethodReserved
		);
	});
}

// --- history ---

#[test]
fn history_survives_clear_identity_but_not_a_purge() {
	ext().execute_with(|| {
		migrate(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::Reasonable)]));
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert!(ImportedHistory::<Test>::contains_key(USER));

		// The account migrated once: it cannot ask again.
		assert_noop!(request(USER, SourceChain::Kusama), Error::<Test>::AlreadyMigrated);

		// A purge deletes the history, and with it the refusal: Root allows a new import. (A
		// purge needs an identity: the person makes one again first.)
		assert_ok!(Identitee::set_field(
			RuntimeOrigin::signed(USER),
			EMAIL,
			FieldValue::Public(value(b"a@x.org"))
		));
		assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), USER));
		assert!(!ImportedHistory::<Test>::contains_key(USER));
		migrate(SourceChain::Kusama, full_payload(&[(7, JudgementLevel::OutOfDate)]));
		assert_eq!(
			ImportedHistory::<Test>::get(USER),
			Some((
				SourceChain::Kusama,
				BLOCK,
				BLOCK_HASH,
				judgements(&[(7, JudgementLevel::OutOfDate)])
			))
		);
	});
}

// --- revocations survive ---

#[test]
fn clearing_and_migrating_again_cannot_undo_a_revocation() {
	ext().execute_with(|| {
		migrate(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::KnownGood)]));
		assert_eq!(trust(), Some(TrustLevel::Certified));

		// Beta takes back what its migration gave.
		assert_ok!(Identitee::revoke_attestation(
			RuntimeOrigin::signed(BETA_OFFICER),
			USER,
			EMAIL,
			ReasonCode::DocumentInvalid
		));
		assert_ok!(Identitee::revoke_fact(
			RuntimeOrigin::signed(BETA_OFFICER),
			USER,
			FactKind::DocumentChecked,
			ReasonCode::DocumentInvalid
		));
		let revoked = facts();

		// Clearing keeps the history and the facts; asking again is refused.
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert_noop!(request(USER, SourceChain::Polkadot), Error::<Test>::AlreadyMigrated);
		assert!(!MigrationRequests::<Test>::contains_key(USER));
		assert_eq!(facts(), revoked);
	});
}

#[test]
fn migration_keeps_the_fact_the_authority_already_recorded() {
	let note = Note::try_from(b"passport".to_vec()).unwrap();
	for revoke in [false, true] {
		ext().execute_with(|| {
			// Beta checked a document by hand, before any migration.
			assert_ok!(Identitee::set_field(
				RuntimeOrigin::signed(USER),
				EMAIL,
				FieldValue::Public(value(b"a@x.org"))
			));
			assert_ok!(Identitee::grant_fact(
				RuntimeOrigin::signed(BETA_OFFICER),
				USER,
				FactKind::DocumentChecked,
				Some(1_000),
				ReasonCode::Other,
				note.clone()
			));
			if revoke {
				assert_ok!(Identitee::revoke_fact(
					RuntimeOrigin::signed(BETA_OFFICER),
					USER,
					FactKind::DocumentChecked,
					ReasonCode::DocumentInvalid
				));
			}
			let before = facts();
			assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
			System::reset_events();

			// The migration would derive the same fact: it leaves Beta's own as it is.
			assert_ok!(request(USER, SourceChain::Polkadot));
			let post =
				fulfil(SourceChain::Polkadot, full_payload(&[(5, JudgementLevel::KnownGood)]))
					.unwrap();
			assert_eq!(facts(), before);
			assert!(!System::events().iter().any(|record| matches!(
				record.event,
				RuntimeEvent::Identitee(Event::FactGranted { .. })
			)));
			use crate::{weights::Imported, WeightInfo};
			assert_eq!(
				post.actual_weight,
				Some(<Test as crate::Config>::WeightInfo::fulfil_migration_actual(Imported {
					attestations: 4,
					facts: 0
				}))
			);
			let expected = if revoke { TrustLevel::FullyVerified } else { TrustLevel::Certified };
			assert_eq!(trust(), Some(expected));
		});
	}
}

#[test]
fn fulfil_reports_what_it_wrote_below_what_it_declares() {
	use crate::{weights::Imported, WeightInfo};
	use frame_support::{dispatch::GetDispatchInfo, traits::UnfilteredDispatchable};
	type Weights = <Test as crate::Config>::WeightInfo;
	for (level, imported) in [
		(JudgementLevel::KnownGood, Imported { attestations: 4, facts: 1 }),
		(JudgementLevel::Erroneous, Imported { attestations: 0, facts: 1 }),
		(JudgementLevel::OutOfDate, Imported::default()),
	] {
		ext().execute_with(|| {
			assert_ok!(request(USER, SourceChain::Polkadot));
			let call = crate::Call::<Test>::fulfil_migration {
				who: USER,
				source: SourceChain::Polkadot,
				block: BLOCK,
				block_hash: BLOCK_HASH,
				payload: full_payload(&[(5, level)]),
			};
			let declared = call.get_dispatch_info().call_weight;
			assert_eq!(declared, Weights::fulfil_migration());
			let post = call.dispatch_bypass_filter(RuntimeOrigin::signed(MIGRATOR)).unwrap();
			let actual = post.actual_weight.expect("reports its weight");
			assert_eq!(actual, Weights::fulfil_migration_actual(imported));
			assert!(actual.all_lt(declared), "{actual:?} not below {declared:?}");
		});
	}
	// The declared weight covers a full payload: every field attested, and the facts.
	let full = Imported {
		attestations: crate::limits::MAX_TYPED_FIELDS + crate::limits::MAX_CUSTOM_FIELDS,
		facts: FactKind::COUNT,
	};
	assert_eq!(Weights::fulfil_migration(), Weights::fulfil_migration_actual(full));
}
