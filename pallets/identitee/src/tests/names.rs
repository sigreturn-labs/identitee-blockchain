use crate::{
	mock::*,
	types::{
		commitment, link_commitment, Capabilities, CustomKey, FactKind, FieldKey, FieldKind,
		FieldValue, LinkTitle, Method, Name, Note, ReasonCode, Value, Verdict,
	},
	Error, Event, LastRelease, NameOf, NameOwner, Quarantine, Reserved,
};
use frame_support::{
	assert_noop, assert_ok, dispatch::CheckIfFeeless, traits::UnfilteredDispatchable,
};
use sp_runtime::{DispatchError, DispatchResult};

/// Two accounts that make their own identity and claim names.
const USER: u64 = 1;
const OTHER: u64 = 2;
const THIRD: u64 = 3;
/// Agent of authority 0 ("Alpha") holding ATTEST_FIELDS only.
const ATTESTER: u64 = 10;
/// Agent of authority 0 holding MANAGE_NAMES only.
const NAMER: u64 = 11;
/// Agent of authority 1 ("Beta") holding ATTEST_FIELDS.
const OTHER_ATTESTER: u64 = 12;
/// Agent of authority 1 holding PERSON_FACTS: records fraud.
const INVESTIGATOR: u64 = 13;

const EMAIL: FieldKey = FieldKey::Typed(FieldKind::Email);
const GITHUB: FieldKey = FieldKey::Typed(FieldKind::GitHub);

fn ext() -> sp_io::TestExternalities {
	new_test_ext_with(crate::GenesisConfig::<Test> {
		authorities: vec![
			authority(
				"Alpha",
				&[
					(ATTESTER, Capabilities::ATTEST_FIELDS.bits()),
					(NAMER, Capabilities::MANAGE_NAMES.bits()),
				],
			),
			authority(
				"Beta",
				&[
					(OTHER_ATTESTER, Capabilities::ATTEST_FIELDS.bits()),
					(INVESTIGATOR, Capabilities::PERSON_FACTS.bits()),
				],
			),
		],
	})
}

fn name(text: &str) -> Name {
	Name::try_from(text.as_bytes().to_vec()).unwrap()
}

fn value(bytes: &[u8]) -> Value {
	Value::try_from(bytes.to_vec()).unwrap()
}

fn custom(key: &[u8]) -> FieldKey {
	FieldKey::Custom(CustomKey::try_from(key.to_vec()).unwrap())
}

fn set(who: u64, key: FieldKey, v: &[u8]) {
	assert_ok!(Identitee::set_field(RuntimeOrigin::signed(who), key, FieldValue::Public(value(v))));
}

/// `agent` gives `verdict` on the public value `v` of `key` of `who`.
fn judge(
	agent: u64,
	who: u64,
	key: FieldKey,
	v: &[u8],
	verdict: Verdict,
	expires_at: Option<u64>,
) -> DispatchResult {
	Identitee::provide_judgement(
		RuntimeOrigin::signed(agent),
		who,
		key,
		commitment(&FieldValue::Public(value(v))),
		verdict,
		Method::EmailCode,
		expires_at,
	)
}

/// Alpha verifies the public value `v` of `key` of `who`.
fn verify(who: u64, key: FieldKey, v: &[u8]) {
	assert_ok!(judge(ATTESTER, who, key, v, Verdict::Verified, None));
}

fn revoke_attestation(agent: u64, who: u64, key: FieldKey) {
	assert_ok!(Identitee::revoke_attestation(
		RuntimeOrigin::signed(agent),
		who,
		key,
		ReasonCode::UserRequest
	));
}

/// Gives `who` an identity with one verified field, so it may claim a name.
fn qualify(who: u64) {
	set(who, EMAIL, b"a@x.org");
	verify(who, EMAIL, b"a@x.org");
}

fn claim(who: u64, text: &str) -> DispatchResult {
	Identitee::claim_username(RuntimeOrigin::signed(who), name(text))
		.map(|_| ())
		.map_err(|e| e.error)
}

fn release(who: u64) -> DispatchResult {
	Identitee::release_username(RuntimeOrigin::signed(who))
}

fn reserve(text: &str) -> DispatchResult {
	Identitee::reserve_username(RuntimeOrigin::signed(NAMER), name(text))
}

fn assign(who: u64, text: &str) -> DispatchResult {
	Identitee::set_username_for(RuntimeOrigin::signed(NAMER), who, name(text))
}

fn revoke(who: u64) -> DispatchResult {
	Identitee::unbind_username(RuntimeOrigin::signed(NAMER), who, ReasonCode::Impersonation)
}

/// Releases the name of `who` and returns the block from which it can be claimed again.
fn release_and_get_until(who: u64) -> u64 {
	assert_ok!(release(who));
	System::block_number() + NAME_QUARANTINE_BLOCKS
}

// --- Claiming ---

#[test]
fn claim_requires_one_valid_verified_attestation() {
	ext().execute_with(|| {
		// No identity at all.
		assert_noop!(claim(USER, "ada"), Error::<Test>::NoIdentity);

		// An identity nobody verified.
		set(USER, EMAIL, b"a@x.org");
		set(USER, GITHUB, b"octo");
		assert_noop!(claim(USER, "ada"), Error::<Test>::NoVerifiedField);

		// One verified field is enough, however many others are not.
		verify(USER, EMAIL, b"a@x.org");
		assert_ok!(claim(USER, "ada"));
		System::assert_last_event(Event::NameClaimed { who: USER, name: name("ada") }.into());
		assert_eq!(NameOf::<Test>::get(USER), Some(name("ada")));
		assert_eq!(NameOwner::<Test>::get(name("ada")), Some(USER));
		assert_eq!(Identitee::resolve(&name("ada")), Some(USER));
		assert_eq!(Identitee::resolve(&name("bob")), None);
	});
}

#[test]
fn invalid_attestations_do_not_qualify() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		let now = System::block_number();

		// Expired: valid up to and including its last block.
		assert_ok!(judge(ATTESTER, USER, EMAIL, b"a@x.org", Verdict::Verified, Some(now + 5)));
		System::set_block_number(now + 6);
		assert_noop!(claim(USER, "ada"), Error::<Test>::NoVerifiedField);

		// Revoked.
		verify(USER, EMAIL, b"a@x.org");
		revoke_attestation(ATTESTER, USER, EMAIL);
		assert_noop!(claim(USER, "ada"), Error::<Test>::NoVerifiedField);

		// Stale: the field changed since it was attested.
		verify(USER, EMAIL, b"a@x.org");
		set(USER, EMAIL, b"b@x.org");
		assert_noop!(claim(USER, "ada"), Error::<Test>::NoVerifiedField);

		// The very same value again makes the attestation valid again.
		set(USER, EMAIL, b"a@x.org");
		assert_ok!(claim(USER, "ada"));
	});
}

#[test]
fn attestation_valid_on_its_last_block_qualifies() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		let now = System::block_number();
		assert_ok!(judge(ATTESTER, USER, EMAIL, b"a@x.org", Verdict::Verified, Some(now + 5)));
		System::set_block_number(now + 5);
		assert_ok!(claim(USER, "ada"));
	});
}

#[test]
fn rejected_field_does_not_qualify() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		// A rejection alone is not a verification.
		assert_ok!(judge(ATTESTER, USER, EMAIL, b"a@x.org", Verdict::Rejected, None));
		assert_noop!(claim(USER, "ada"), Error::<Test>::NoVerifiedField);

		// A valid rejection from any authority cancels another authority's verification.
		assert_ok!(judge(OTHER_ATTESTER, USER, EMAIL, b"a@x.org", Verdict::Verified, None));
		assert_noop!(claim(USER, "ada"), Error::<Test>::NoVerifiedField);

		// Another, clean field qualifies despite the rejected one.
		set(USER, GITHUB, b"octo");
		verify(USER, GITHUB, b"octo");
		assert_ok!(claim(USER, "ada"));
	});
}

#[test]
fn revoked_rejection_stops_blocking() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		assert_ok!(judge(OTHER_ATTESTER, USER, EMAIL, b"a@x.org", Verdict::Verified, None));
		assert_ok!(judge(ATTESTER, USER, EMAIL, b"a@x.org", Verdict::Rejected, None));
		assert_noop!(claim(USER, "ada"), Error::<Test>::NoVerifiedField);
		revoke_attestation(ATTESTER, USER, EMAIL);
		assert_ok!(claim(USER, "ada"));
	});
}

#[test]
fn custom_fields_and_links_qualify() {
	ext().execute_with(|| {
		// A verified custom field.
		set(USER, custom(b"mastodon"), b"@ada@x.social");
		verify(USER, custom(b"mastodon"), b"@ada@x.social");
		assert_ok!(claim(USER, "ada"));

		// A verified link.
		let title = LinkTitle::try_from(b"home".to_vec()).unwrap();
		let url = value(b"https://ada.example");
		assert_ok!(Identitee::add_link(RuntimeOrigin::signed(OTHER), title.clone(), url.clone()));
		assert_noop!(claim(OTHER, "bob"), Error::<Test>::NoVerifiedField);
		assert_ok!(Identitee::provide_judgement(
			RuntimeOrigin::signed(ATTESTER),
			OTHER,
			FieldKey::Link(0),
			link_commitment(&title, &url),
			Verdict::Verified,
			Method::Manual,
			None,
		));
		assert_ok!(claim(OTHER, "bob"));
	});
}

#[test]
fn bio_alone_does_not_qualify() {
	ext().execute_with(|| {
		// Only fields can be attested: an identity with just a bio has nothing to qualify with.
		assert_ok!(Identitee::set_bio(
			RuntimeOrigin::signed(USER),
			b"hello".to_vec().try_into().unwrap()
		));
		assert_noop!(claim(USER, "ada"), Error::<Test>::NoVerifiedField);
	});
}

#[test]
fn claim_validates_the_name() {
	ext().execute_with(|| {
		qualify(USER);
		// Uppercase, spaces and non-ASCII are refused as they are: nothing is normalised.
		for bad in ["Alice", "al ice", "alïce", "\u{0430}lice", "ada!", "ada.", "ADA"] {
			assert_noop!(claim(USER, bad), Error::<Test>::NameInvalidChar);
		}
		assert_noop!(claim(USER, "ab"), Error::<Test>::NameTooShort);
		assert_noop!(claim(USER, ""), Error::<Test>::NameTooShort);
		// A longer name does not even decode: the type bounds it.
		assert!(Name::try_from(vec![b'a'; 33]).is_err());

		// Digits, hyphen and underscore are allowed.
		assert_ok!(claim(USER, "a-b_9"));
		assert_eq!(NameOf::<Test>::get(USER), Some(name("a-b_9")));
	});
}

#[test]
fn one_name_per_identity() {
	ext().execute_with(|| {
		qualify(USER);
		assert_ok!(claim(USER, "ada"));
		assert_noop!(claim(USER, "bob"), Error::<Test>::AlreadyHasName);
		assert_noop!(claim(USER, "ada"), Error::<Test>::AlreadyHasName);
		assert_eq!(NameOf::<Test>::get(USER), Some(name("ada")));
		assert_eq!(NameOwner::<Test>::get(name("bob")), None);
	});
}

#[test]
fn taken_name_cannot_be_claimed() {
	ext().execute_with(|| {
		qualify(USER);
		qualify(OTHER);
		assert_ok!(claim(USER, "ada"));
		assert_noop!(claim(OTHER, "ada"), Error::<Test>::NameTaken);
		assert_eq!(NameOwner::<Test>::get(name("ada")), Some(USER));
		assert_eq!(NameOf::<Test>::get(OTHER), None);
	});
}

#[test]
fn a_name_is_unique_and_two_way() {
	ext().execute_with(|| {
		qualify(USER);
		qualify(OTHER);
		assert_ok!(claim(USER, "ada"));
		assert_ok!(claim(OTHER, "bob"));
		for (who, text) in [(USER, "ada"), (OTHER, "bob")] {
			assert_eq!(NameOf::<Test>::get(who), Some(name(text)));
			assert_eq!(NameOwner::<Test>::get(name(text)), Some(who));
		}
		assert_eq!(NameOf::<Test>::iter().count(), NameOwner::<Test>::iter().count());
	});
}

// --- Reservations ---

#[test]
fn reserved_name_cannot_be_claimed() {
	ext().execute_with(|| {
		qualify(USER);
		assert_ok!(reserve("polkadot"));
		System::assert_last_event(Event::NameReserved { name: name("polkadot") }.into());
		assert!(Reserved::<Test>::contains_key(name("polkadot")));
		assert_noop!(claim(USER, "polkadot"), Error::<Test>::NameIsReserved);

		// Lifting the reservation frees it.
		assert_ok!(Identitee::unreserve_username(RuntimeOrigin::signed(NAMER), name("polkadot")));
		System::assert_last_event(Event::NameUnreserved { name: name("polkadot") }.into());
		assert!(!Reserved::<Test>::contains_key(name("polkadot")));
		assert_ok!(claim(USER, "polkadot"));
	});
}

#[test]
fn reservations_are_checked() {
	ext().execute_with(|| {
		qualify(USER);
		// Only valid names are reserved.
		assert_noop!(reserve("Polkadot"), Error::<Test>::NameInvalidChar);
		assert_noop!(reserve("po"), Error::<Test>::NameTooShort);

		assert_ok!(reserve("polkadot"));
		assert_noop!(reserve("polkadot"), Error::<Test>::AlreadyReserved);

		// A name somebody owns is not reserved: the reservation would apply to nobody.
		assert_ok!(claim(USER, "ada"));
		assert_noop!(reserve("ada"), Error::<Test>::NameTaken);

		// Unreserving what is not reserved.
		assert_noop!(
			Identitee::unreserve_username(RuntimeOrigin::signed(NAMER), name("kusama")),
			Error::<Test>::NotReserved
		);
	});
}

#[test]
fn assign_reserved_name_by_agent() {
	ext().execute_with(|| {
		// USER has an identity but nothing verified: assigning does not need the attestation.
		set(USER, EMAIL, b"a@x.org");
		assert_ok!(reserve("polkadot"));
		assert_ok!(assign(USER, "polkadot"));
		System::assert_last_event(Event::NameAssigned { who: USER, name: name("polkadot") }.into());

		assert_eq!(NameOf::<Test>::get(USER), Some(name("polkadot")));
		assert_eq!(NameOwner::<Test>::get(name("polkadot")), Some(USER));
		// The reservation is consumed.
		assert!(!Reserved::<Test>::contains_key(name("polkadot")));
	});
}

#[test]
fn assign_a_name_that_is_not_reserved() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		assert_ok!(assign(USER, "ada"));
		assert_eq!(NameOf::<Test>::get(USER), Some(name("ada")));
	});
}

#[test]
fn assign_checks_the_target_and_the_name() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		set(OTHER, EMAIL, b"o@x.org");
		// The target needs an identity.
		assert_noop!(assign(3, "ada"), Error::<Test>::NoIdentity);
		// The name must be valid.
		assert_noop!(assign(USER, "Ada"), Error::<Test>::NameInvalidChar);
		assert_noop!(assign(USER, "ad"), Error::<Test>::NameTooShort);

		assert_ok!(assign(USER, "ada"));
		// One name per identity, even from an agent.
		assert_noop!(assign(USER, "bob"), Error::<Test>::AlreadyHasName);
		// And a name has one owner.
		assert_noop!(assign(OTHER, "ada"), Error::<Test>::NameTaken);
	});
}

#[test]
fn assign_does_not_override_the_quarantine() {
	ext().execute_with(|| {
		qualify(USER);
		set(OTHER, EMAIL, b"o@x.org");
		assert_ok!(claim(USER, "ada"));
		let until = release_and_get_until(USER);

		System::set_block_number(until - 1);
		assert_noop!(assign(OTHER, "ada"), Error::<Test>::NameInQuarantine);

		// At the end of the quarantine the entry is cleaned up by the assignment.
		System::set_block_number(until);
		assert_ok!(assign(OTHER, "ada"));
		assert!(!Quarantine::<Test>::contains_key(name("ada")));
		assert_eq!(NameOf::<Test>::get(OTHER), Some(name("ada")));
	});
}

// --- Quarantine ---

#[test]
fn released_name_quarantined_30_days() {
	ext().execute_with(|| {
		qualify(USER);
		qualify(OTHER);
		assert_ok!(claim(USER, "ada"));
		let released_at = System::block_number();
		assert_ok!(release(USER));
		System::assert_last_event(Event::NameReleased { who: USER, name: name("ada") }.into());

		// The mock sets a short quarantine; the runtime sets 30 days (see its tests).
		let until = released_at + NAME_QUARANTINE_BLOCKS;
		assert_eq!(Quarantine::<Test>::get(name("ada")), Some(until));
		assert_eq!(NameOf::<Test>::get(USER), None);
		assert_eq!(NameOwner::<Test>::get(name("ada")), None);
		assert_eq!(Identitee::resolve(&name("ada")), None);

		// Not before: a newcomer is refused on the quarantine up to its last block...
		for block in [released_at, released_at + 1, until - 1] {
			System::set_block_number(block);
			assert_noop!(claim(OTHER, "ada"), Error::<Test>::NameInQuarantine);
		}
		// ...and so is the former owner, once its own cooldown (shorter) is over.
		System::set_block_number(released_at + QUOTA_WINDOW_BLOCKS);
		assert_noop!(claim(USER, "ada"), Error::<Test>::NameInQuarantine);
		System::set_block_number(until - 1);
		assert_noop!(claim(USER, "ada"), Error::<Test>::NameInQuarantine);

		// From `until` on, and the entry is cleaned up by the claim.
		System::set_block_number(until);
		assert_ok!(claim(OTHER, "ada"));
		assert_eq!(NameOwner::<Test>::get(name("ada")), Some(OTHER));
		assert!(!Quarantine::<Test>::contains_key(name("ada")));
	});
}

#[test]
fn quarantine_does_not_touch_other_names() {
	ext().execute_with(|| {
		qualify(USER);
		qualify(OTHER);
		assert_ok!(claim(USER, "ada"));
		assert_ok!(release(USER));
		// Another account takes another name at once.
		assert_ok!(claim(OTHER, "bob"));
		// The former owner may take another name once its cooldown is over, while "ada" is still
		// in quarantine.
		System::set_block_number(System::block_number() + QUOTA_WINDOW_BLOCKS);
		assert!(QUOTA_WINDOW_BLOCKS < NAME_QUARANTINE_BLOCKS);
		assert_ok!(claim(USER, "carol"));
		assert!(Quarantine::<Test>::contains_key(name("ada")));
	});
}

#[test]
fn release_without_a_name_fails() {
	ext().execute_with(|| {
		qualify(USER);
		assert_noop!(release(USER), Error::<Test>::NoName);
		assert_noop!(release(3), Error::<Test>::NoName);
		// A release that did nothing starts no cooldown.
		assert_eq!(LastRelease::<Test>::get(USER), None);
	});
}

#[test]
fn name_kept_when_attestation_becomes_invalid() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		let now = System::block_number();
		assert_ok!(judge(ATTESTER, USER, EMAIL, b"a@x.org", Verdict::Verified, Some(now + 5)));
		assert_ok!(claim(USER, "ada"));
		let kept = || {
			assert_eq!(NameOf::<Test>::get(USER), Some(name("ada")));
			assert_eq!(Identitee::resolve(&name("ada")), Some(USER));
			assert!(!Quarantine::<Test>::contains_key(name("ada")));
		};

		// Expired.
		System::set_block_number(now + 6);
		kept();
		// Revoked.
		verify(USER, EMAIL, b"a@x.org");
		revoke_attestation(ATTESTER, USER, EMAIL);
		kept();
		// Stale, then the field removed altogether.
		set(USER, EMAIL, b"b@x.org");
		kept();
		assert_ok!(Identitee::clear_field(RuntimeOrigin::signed(USER), EMAIL));
		kept();
	});
}

// --- Revocation and agents ---

#[test]
fn revoke_name_moves_it_to_quarantine() {
	ext().execute_with(|| {
		qualify(USER);
		assert_ok!(claim(USER, "ada"));
		let revoked_at = System::block_number();
		assert_ok!(revoke(USER));
		System::assert_last_event(
			Event::NameRevoked { who: USER, name: name("ada"), reason: ReasonCode::Impersonation }
				.into(),
		);

		assert_eq!(NameOf::<Test>::get(USER), None);
		assert_eq!(NameOwner::<Test>::get(name("ada")), None);
		let until = revoked_at + NAME_QUARANTINE_BLOCKS;
		assert_eq!(Quarantine::<Test>::get(name("ada")), Some(until));

		// The revoked name stays out of reach, for its former owner too.
		System::set_block_number(until - 1);
		assert_noop!(claim(USER, "ada"), Error::<Test>::NameInQuarantine);
		System::set_block_number(until);
		assert_ok!(claim(USER, "ada"));
	});
}

#[test]
fn revoke_name_needs_a_name() {
	ext().execute_with(|| {
		qualify(USER);
		assert_noop!(revoke(USER), Error::<Test>::NoName);
		assert_noop!(revoke(3), Error::<Test>::NoName);
	});
}

/// One value of each call reserved to agents holding MANAGE_NAMES.
fn name_agent_calls() -> Vec<crate::Call<Test>> {
	vec![
		crate::Call::reserve_username { name: name("polkadot") },
		crate::Call::unreserve_username { name: name("polkadot") },
		crate::Call::set_username_for { who: USER, name: name("polkadot") },
		crate::Call::unbind_username { who: USER, reason: ReasonCode::Abuse },
	]
}

fn dispatch(call: &crate::Call<Test>, origin: RuntimeOrigin) -> Result<(), DispatchError> {
	call.clone().dispatch_bypass_filter(origin).map(|_| ()).map_err(|e| e.error)
}

#[test]
fn revoke_requires_manage_names() {
	ext().execute_with(|| {
		qualify(USER);
		assert_ok!(claim(USER, "ada"));
		assert_ok!(reserve("polkadot"));

		for call in name_agent_calls() {
			// An agent of an active authority without the capability.
			let signed = RuntimeOrigin::signed;
			assert_noop!(dispatch(&call, signed(ATTESTER)), Error::<Test>::MissingCapability);
			// Plain accounts, the owner included.
			assert_noop!(dispatch(&call, signed(USER)), Error::<Test>::NotAnAgent);
			assert_noop!(dispatch(&call, signed(99)), Error::<Test>::NotAnAgent);
			// Not signed at all.
			assert_noop!(dispatch(&call, RuntimeOrigin::none()), DispatchError::BadOrigin);
		}
		assert_eq!(NameOf::<Test>::get(USER), Some(name("ada")));
		assert!(Reserved::<Test>::contains_key(name("polkadot")));

		// An inactive authority's agent cannot act either.
		assert_ok!(Identitee::set_authority_active(RuntimeOrigin::root(), 0, false));
		for call in name_agent_calls() {
			assert_noop!(
				dispatch(&call, RuntimeOrigin::signed(NAMER)),
				Error::<Test>::AuthorityInactive
			);
		}
	});
}

#[test]
fn name_calls_are_feeless_for_the_right_signers() {
	ext().execute_with(|| {
		let feeless = |call: &crate::Call<Test>, who: u64| {
			RuntimeCall::Identitee(call.clone()).is_feeless(&RuntimeOrigin::signed(who))
		};

		// Agent calls: only for an agent holding MANAGE_NAMES, and never counted as user calls.
		for call in name_agent_calls() {
			assert!(feeless(&call, NAMER), "{call:?}");
			assert!(!feeless(&call, ATTESTER), "{call:?}");
			assert!(!feeless(&call, USER), "{call:?}");
			// Root may make them but pays: no fee exemption without an agent.
			assert!(
				!RuntimeCall::Identitee(call.clone()).is_feeless(&RuntimeOrigin::root()),
				"{call:?}"
			);
			assert!(!call.counts_against_quota(), "{call:?}");
		}

		// User calls: any signed account within its quota.
		let claim_call = crate::Call::<Test>::claim_username { name: name("ada") };
		let release_call = crate::Call::<Test>::release_username {};
		for call in [claim_call, release_call] {
			assert!(feeless(&call, USER), "{call:?}");
			assert!(call.counts_against_quota(), "{call:?}");
			assert!(
				!RuntimeCall::Identitee(call.clone()).is_feeless(&RuntimeOrigin::root()),
				"{call:?}"
			);
		}
	});
}

// --- Clearing the identity ---

#[test]
fn clear_identity_quarantines_name() {
	ext().execute_with(|| {
		qualify(USER);
		assert_ok!(claim(USER, "ada"));
		let cleared_at = System::block_number();
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));

		System::assert_has_event(Event::NameReleased { who: USER, name: name("ada") }.into());
		System::assert_last_event(Event::IdentityCleared { who: USER }.into());
		assert_eq!(NameOf::<Test>::get(USER), None);
		assert_eq!(NameOwner::<Test>::get(name("ada")), None);
		let until = cleared_at + NAME_QUARANTINE_BLOCKS;
		assert_eq!(Quarantine::<Test>::get(name("ada")), Some(until));

		// The person comes back with a new identity and cannot take the name before `until`.
		qualify(USER);
		System::set_block_number(until - 1);
		assert_noop!(claim(USER, "ada"), Error::<Test>::NameInQuarantine);
		System::set_block_number(until);
		assert_ok!(claim(USER, "ada"));
	});
}

#[test]
fn kill_identity_quarantines_name() {
	ext().execute_with(|| {
		qualify(USER);
		assert_ok!(claim(USER, "ada"));
		let cleared_at = System::block_number();
		assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), USER));

		System::assert_has_event(Event::NameReleased { who: USER, name: name("ada") }.into());
		assert_eq!(NameOf::<Test>::get(USER), None);
		assert_eq!(NameOwner::<Test>::get(name("ada")), None);
		assert_eq!(Quarantine::<Test>::get(name("ada")), Some(cleared_at + NAME_QUARANTINE_BLOCKS));
	});
}

#[test]
fn clear_identity_without_a_name_quarantines_nothing() {
	ext().execute_with(|| {
		qualify(USER);
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(USER)));
		assert_eq!(Quarantine::<Test>::iter().count(), 0);
		assert!(!System::events().iter().any(|record| matches!(
			record.event,
			RuntimeEvent::Identitee(Event::NameReleased { .. })
		)));
	});
}

// --- Cooldown after a voluntary release ---

#[test]
fn voluntary_release_starts_a_claim_cooldown() {
	ext().execute_with(|| {
		qualify(USER);
		assert_ok!(claim(USER, "ada"));
		let released_at = System::block_number();
		assert_ok!(release(USER));
		assert_eq!(LastRelease::<Test>::get(USER), Some(released_at));

		// Refused for a whole quota window, whatever the name, up to its last block...
		for block in [released_at, released_at + 1, released_at + QUOTA_WINDOW_BLOCKS - 1] {
			System::set_block_number(block);
			assert_noop!(claim(USER, "bob"), Error::<Test>::ClaimCooldown);
		}
		assert_eq!(NameOf::<Test>::get(USER), None);

		// ...and allowed from the block the window ends, which clears the record.
		System::set_block_number(released_at + QUOTA_WINDOW_BLOCKS);
		assert_ok!(claim(USER, "bob"));
		assert_eq!(LastRelease::<Test>::get(USER), None);
	});
}

#[test]
fn claim_and_release_in_a_loop_freezes_one_name_per_window() {
	ext().execute_with(|| {
		qualify(USER);
		// The cycle the cooldown exists to slow down: without it, every pass could put one more
		// name in quarantine within the same window.
		let frozen = || {
			let now = System::block_number();
			Quarantine::<Test>::iter().filter(|(_, until)| *until > now).count()
		};
		// The quarantine lasts two windows in the mock, so at most two names are frozen at once.
		let at_most = (NAME_QUARANTINE_BLOCKS / QUOTA_WINDOW_BLOCKS) as usize;
		for (round, label) in ["aaa", "bbb", "ccc", "ddd"].into_iter().enumerate() {
			assert_ok!(claim(USER, label));
			assert_ok!(release(USER));
			assert_noop!(claim(USER, "zzz"), Error::<Test>::ClaimCooldown);
			assert_eq!(frozen(), (round + 1).min(at_most));
			System::set_block_number(System::block_number() + QUOTA_WINDOW_BLOCKS);
		}
	});
}

#[test]
fn only_a_voluntary_release_starts_the_cooldown() {
	ext().execute_with(|| {
		qualify(USER);
		qualify(OTHER);
		qualify(THIRD);
		assert_ok!(claim(USER, "ada"));
		assert_ok!(claim(OTHER, "bob"));
		assert_ok!(claim(THIRD, "carol"));

		// A revocation: the account may claim another name at once.
		assert_ok!(revoke(USER));
		assert_eq!(LastRelease::<Test>::get(USER), None);
		assert_ok!(claim(USER, "dave"));

		// Clearing the identity: same, once the identity is back.
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(OTHER)));
		assert_eq!(LastRelease::<Test>::get(OTHER), None);
		qualify(OTHER);
		assert_ok!(claim(OTHER, "erin"));

		// Purging the identity.
		assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), THIRD));
		assert_eq!(LastRelease::<Test>::get(THIRD), None);
		qualify(THIRD);
		assert_ok!(claim(THIRD, "frank"));
	});
}

#[test]
fn assign_ignores_the_cooldown() {
	ext().execute_with(|| {
		qualify(USER);
		assert_ok!(claim(USER, "ada"));
		assert_ok!(release(USER));
		assert_noop!(claim(USER, "bob"), Error::<Test>::ClaimCooldown);
		// An agent can give a name to the account at once.
		assert_ok!(assign(USER, "bob"));
		assert_eq!(NameOf::<Test>::get(USER), Some(name("bob")));
	});
}

#[test]
fn cooldown_is_per_account() {
	ext().execute_with(|| {
		qualify(USER);
		qualify(OTHER);
		assert_ok!(claim(USER, "ada"));
		assert_ok!(release(USER));
		assert_ok!(claim(OTHER, "bob"));
	});
}

// --- Root manages names ---

#[test]
fn root_manages_names_without_being_an_agent() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		let root = RuntimeOrigin::root;

		assert_ok!(Identitee::reserve_username(root(), name("polkadot")));
		System::assert_last_event(Event::NameReserved { name: name("polkadot") }.into());
		assert_ok!(Identitee::unreserve_username(root(), name("polkadot")));
		System::assert_last_event(Event::NameUnreserved { name: name("polkadot") }.into());
		assert_ok!(Identitee::reserve_username(root(), name("polkadot")));

		// Assigns without attestation, consuming the reservation.
		assert_ok!(Identitee::set_username_for(root(), USER, name("polkadot")));
		assert_eq!(NameOf::<Test>::get(USER), Some(name("polkadot")));
		assert!(!Reserved::<Test>::contains_key(name("polkadot")));

		assert_ok!(Identitee::unbind_username(root(), USER, ReasonCode::Abuse));
		System::assert_last_event(
			Event::NameRevoked { who: USER, name: name("polkadot"), reason: ReasonCode::Abuse }
				.into(),
		);
		assert!(Quarantine::<Test>::contains_key(name("polkadot")));
	});
}

#[test]
fn root_still_meets_the_rules_of_each_call() {
	ext().execute_with(|| {
		let root = RuntimeOrigin::root;
		assert_noop!(
			Identitee::reserve_username(root(), name("Polkadot")),
			Error::<Test>::NameInvalidChar
		);
		assert_noop!(
			Identitee::unreserve_username(root(), name("kusama")),
			Error::<Test>::NotReserved
		);
		assert_noop!(
			Identitee::set_username_for(root(), USER, name("ada")),
			Error::<Test>::NoIdentity
		);
		assert_noop!(
			Identitee::unbind_username(root(), USER, ReasonCode::Abuse),
			Error::<Test>::NoName
		);
	});
}

#[test]
fn root_works_while_every_authority_is_inactive() {
	ext().execute_with(|| {
		assert_ok!(Identitee::set_authority_active(RuntimeOrigin::root(), 0, false));
		assert_noop!(reserve("polkadot"), Error::<Test>::AuthorityInactive);
		assert_ok!(Identitee::reserve_username(RuntimeOrigin::root(), name("polkadot")));
	});
}

// --- Consistency of the four maps ---

/// `NameOwner` and `NameOf` are exact mirrors, and no owned name is reserved or in quarantine.
fn assert_names_consistent() {
	use std::collections::BTreeMap;
	let owners: BTreeMap<Name, u64> = NameOwner::<Test>::iter().collect();
	let names: BTreeMap<u64, Name> = NameOf::<Test>::iter().collect();
	assert_eq!(owners.len(), names.len(), "{owners:?} {names:?}");
	for (name, who) in &owners {
		assert_eq!(names.get(who), Some(name), "owner {who} of {name:?} has another name");
	}
	for (who, name) in &names {
		assert_eq!(owners.get(name), Some(who), "name {name:?} of {who} has another owner");
	}
	for name in Reserved::<Test>::iter_keys() {
		assert!(!owners.contains_key(&name), "{name:?} is both owned and reserved");
	}
	for name in Quarantine::<Test>::iter_keys() {
		assert!(!owners.contains_key(&name), "{name:?} is both owned and in quarantine");
	}
}

#[test]
fn names_stay_consistent_through_a_mixed_sequence() {
	ext().execute_with(|| {
		for who in [USER, OTHER, THIRD] {
			qualify(who);
		}
		assert_names_consistent();

		assert_ok!(claim(USER, "ada"));
		assert_ok!(claim(THIRD, "carol"));
		assert_names_consistent();

		assert_ok!(reserve("polkadot"));
		assert_names_consistent();
		assert_ok!(assign(OTHER, "polkadot"));
		assert_names_consistent();

		// Revoked: the account may claim again at once.
		assert_ok!(revoke(USER));
		assert_names_consistent();
		assert_ok!(claim(USER, "dave"));
		assert_names_consistent();

		assert_ok!(release(OTHER));
		assert_names_consistent();
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(THIRD)));
		assert_names_consistent();
		assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), USER));
		assert_names_consistent();

		// Everything released: four names in quarantine, nobody owns one.
		assert_eq!(NameOwner::<Test>::iter().count(), 0);
		assert_eq!(Quarantine::<Test>::iter().count(), 4);

		// After the quarantine, the names can be taken again and the old entries are replaced.
		System::set_block_number(System::block_number() + NAME_QUARANTINE_BLOCKS);
		assert_ok!(claim(OTHER, "ada"));
		assert_names_consistent();
		qualify(THIRD);
		assert_ok!(claim(THIRD, "polkadot"));
		assert_names_consistent();
		qualify(USER);
		assert_ok!(claim(USER, "dave"));
		assert_names_consistent();
		assert_eq!(NameOwner::<Test>::iter().count(), 3);
		// "carol" was never taken again: its ended quarantine is still stored, and harmless.
		assert!(Quarantine::<Test>::contains_key(name("carol")));
	});
}

#[test]
fn a_name_of_the_maximum_length_can_be_claimed() {
	ext().execute_with(|| {
		qualify(USER);
		let longest = "a".repeat(crate::limits::NAME_MAX as usize);
		assert_ok!(claim(USER, &longest));
		assert_eq!(Identitee::resolve(&name(&longest)), Some(USER));
		assert_names_consistent();
	});
}

#[test]
fn a_reserved_name_in_quarantine_stays_reserved() {
	ext().execute_with(|| {
		qualify(USER);
		qualify(OTHER);
		assert_ok!(claim(USER, "ada"));
		let revoked_at = System::block_number();
		assert_ok!(revoke(USER));
		let until = revoked_at + NAME_QUARANTINE_BLOCKS;

		// A name in quarantine can be reserved: nobody owns it.
		assert_ok!(reserve("ada"));
		assert_names_consistent();

		// During the quarantine: claiming says reserved, assigning says quarantine.
		System::set_block_number(until - 1);
		assert_noop!(claim(OTHER, "ada"), Error::<Test>::NameIsReserved);
		assert_noop!(assign(OTHER, "ada"), Error::<Test>::NameInQuarantine);

		// After it: still reserved for claims, and assigning consumes both entries.
		System::set_block_number(until);
		assert_noop!(claim(OTHER, "ada"), Error::<Test>::NameIsReserved);
		assert_ok!(assign(OTHER, "ada"));
		assert!(!Reserved::<Test>::contains_key(name("ada")));
		assert!(!Quarantine::<Test>::contains_key(name("ada")));
		assert_eq!(NameOf::<Test>::get(OTHER), Some(name("ada")));
		assert_names_consistent();
	});
}

// --- fraud ---

/// Beta records fraud about `who`, active until `expires_at`.
fn flag_fraud(who: u64, expires_at: Option<u64>) {
	assert_ok!(Identitee::grant_fact(
		RuntimeOrigin::signed(INVESTIGATOR),
		who,
		FactKind::Fraud,
		expires_at,
		ReasonCode::Impersonation,
		Note::default()
	));
}

#[test]
fn a_fraudulent_identity_cannot_claim_a_name() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		verify(USER, EMAIL, b"a@x.org");
		// Alpha verified the email; Beta found fraud: the finding wins, whoever made it.
		flag_fraud(USER, None);
		assert_noop!(claim(USER, "ada"), Error::<Test>::FraudFlagged);

		// Once revoked, the fact no longer stands in the way.
		assert_ok!(Identitee::revoke_fact(
			RuntimeOrigin::signed(INVESTIGATOR),
			USER,
			FactKind::Fraud,
			ReasonCode::Other
		));
		assert_ok!(claim(USER, "ada"));
	});
}

#[test]
fn an_expired_fraud_fact_does_not_block_a_claim() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		verify(USER, EMAIL, b"a@x.org");
		flag_fraud(USER, Some(5));
		System::set_block_number(5);
		assert_noop!(claim(USER, "ada"), Error::<Test>::FraudFlagged);
		System::set_block_number(6);
		assert_ok!(claim(USER, "ada"));
	});
}

#[test]
fn a_manager_can_still_assign_a_name_to_a_fraudulent_identity() {
	ext().execute_with(|| {
		set(USER, EMAIL, b"a@x.org");
		flag_fraud(USER, None);
		assert_ok!(Identitee::set_username_for(RuntimeOrigin::signed(NAMER), USER, name("ada")));
		assert_eq!(Identitee::resolve(&name("ada")), Some(USER));
	});
}
