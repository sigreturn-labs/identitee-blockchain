//! `claim_username`, `clear_identity` and `kill_identity` are free for the caller and have a
//! large worst case. They declare it, and report the weight they actually used, so that calls
//! that do almost nothing do not fill a block.

use crate::{
	limits::{
		MAX_AUTHORITIES, MAX_CUSTOM_FIELDS, MAX_FIELD_CHANGES, MAX_LINKS, MAX_PENDING_REQUESTS,
		MAX_SECRET_BLOB_LEN, MAX_SUBS,
	},
	mock::*,
	types::{
		Capabilities, CustomKey, FactKind, FieldChanges, FieldKey, FieldKind, FieldValue,
		LinkTitle, Method, Name, Note, ReasonCode, SubLabel, Target, Value, Verdict,
	},
	weights::{max_scan_reads, Cleared},
	Error, Quarantine, WeightInfo,
};
use frame_support::{
	assert_ok, dispatch::GetDispatchInfo, traits::UnfilteredDispatchable, weights::Weight,
};
use sp_runtime::DispatchError;

type Weights = <Test as crate::Config>::WeightInfo;

const OWNER: u64 = 1;

/// Every kind of typed field, in the order of the identity.
const KINDS: [FieldKind; 10] = [
	FieldKind::DisplayName,
	FieldKind::LegalName,
	FieldKind::Web,
	FieldKind::Email,
	FieldKind::Matrix,
	FieldKind::X,
	FieldKind::Discord,
	FieldKind::GitHub,
	FieldKind::Telegram,
	FieldKind::Pgp,
];

/// Agent of authority `i`, holding ATTEST_FIELDS and PERSON_FACTS.
fn agent(i: u32) -> u64 {
	100 + u64::from(i)
}

/// All `MAX_AUTHORITIES` authorities, each with an agent.
fn ext() -> sp_io::TestExternalities {
	let caps = (Capabilities::ATTEST_FIELDS | Capabilities::PERSON_FACTS).bits();
	new_test_ext_with(crate::GenesisConfig::<Test> {
		authorities: (0..MAX_AUTHORITIES)
			.map(|i| authority(&format!("A{i}"), &[(agent(i), caps)]))
			.collect(),
	})
}

fn value(bytes: Vec<u8>) -> Value {
	Value::try_from(bytes).unwrap()
}

fn custom(i: u32) -> FieldKey {
	FieldKey::Custom(CustomKey::try_from(format!("k{i}").into_bytes()).unwrap())
}

fn put(who: u64, key: FieldKey, bytes: Vec<u8>) {
	assert_ok!(Identitee::set_field(
		RuntimeOrigin::signed(who),
		key,
		FieldValue::Public(value(bytes))
	));
}

/// Gives `who` the fullest identity: every kind of typed field, `MAX_CUSTOM_FIELDS` custom
/// fields and `MAX_LINKS` links. The keys, in the order of the identity.
fn fill_identity(who: u64) -> Vec<FieldKey> {
	let mut keys = vec![];
	for kind in KINDS {
		// A PGP fingerprint is raw bytes of a fixed length.
		let bytes =
			if kind == FieldKind::Pgp { vec![7; 20] } else { format!("{kind:?}").into_bytes() };
		put(who, FieldKey::Typed(kind), bytes);
		keys.push(FieldKey::Typed(kind));
	}
	for i in 0..MAX_CUSTOM_FIELDS {
		put(who, custom(i), b"v".to_vec());
		keys.push(custom(i));
	}
	for id in 0..MAX_LINKS {
		let title = LinkTitle::try_from(b"t".to_vec()).unwrap();
		assert_ok!(Identitee::add_link(RuntimeOrigin::signed(who), title, value(b"u".to_vec())));
		keys.push(FieldKey::Link(id));
	}
	keys
}

/// Authority `authority` gives `verdict` on the current value of `key` of `who`.
fn attest(authority: u32, who: u64, key: &FieldKey, verdict: Verdict) {
	assert_ok!(Identitee::provide_judgement(
		RuntimeOrigin::signed(agent(authority)),
		who,
		key.clone(),
		Identitee::current_commitment(&who, key).expect("the field exists"),
		verdict,
		Method::Manual,
		None,
	));
}

fn claim_call(text: &str) -> crate::Call<Test> {
	crate::Call::claim_username { name: Name::try_from(text.as_bytes().to_vec()).unwrap() }
}

/// What a dispatch said: its error if any, the weight it reported (a call that does not report
/// one fails the test) and the weight it declared.
struct Dispatched {
	error: Option<DispatchError>,
	actual: Weight,
	declared: Weight,
}

fn run(call: crate::Call<Test>, origin: RuntimeOrigin) -> Dispatched {
	let declared = call.get_dispatch_info().call_weight;
	let (error, post_info) = match call.dispatch_bypass_filter(origin) {
		Ok(post_info) => (None, post_info),
		Err(e) => (Some(e.error), e.post_info),
	};
	let actual = post_info.actual_weight.expect("the call reports the weight it used");
	Dispatched { error, actual, declared }
}

fn signed(who: u64) -> RuntimeOrigin {
	RuntimeOrigin::signed(who)
}

impl Dispatched {
	fn failed_with(&self, error: Error<Test>) -> &Self {
		assert_eq!(self.error, Some(error.into()));
		self
	}

	fn succeeded(&self) -> &Self {
		assert_eq!(self.error, None);
		self
	}

	/// The reported weight is exactly `expected` and strictly below the declared one.
	fn reported(&self, expected: Weight) -> &Self {
		assert_eq!(self.actual, expected);
		assert!(
			self.actual.all_lt(self.declared),
			"reported {:?} is not below declared {:?}",
			self.actual,
			self.declared
		);
		self
	}

	/// The reported weight is below the declared one by two orders of magnitude.
	fn tiny(&self) -> &Self {
		assert!(self.actual.ref_time() * 100 < self.declared.ref_time(), "{:?}", self);
		assert!(self.actual.proof_size() * 100 < self.declared.proof_size(), "{:?}", self);
		self
	}

	/// The reported weight is exactly `expected`, which the declared one covers.
	fn within(&self, expected: Weight) -> &Self {
		assert_eq!(self.actual, expected);
		assert!(
			self.actual.all_lte(self.declared),
			"reported {:?} exceeds declared {:?}",
			self.actual,
			self.declared
		);
		self
	}
}

impl core::fmt::Debug for Dispatched {
	fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
		write!(f, "actual {:?}, declared {:?}", self.actual, self.declared)
	}
}

// --- claim_username ---

#[test]
fn claim_name_that_fails_early_reports_a_tiny_weight() {
	ext().execute_with(|| {
		let early = Weights::claim_username_early();
		put(OWNER, FieldKey::Typed(FieldKind::Email), b"a@x.org".to_vec());
		attest(0, OWNER, &FieldKey::Typed(FieldKind::Email), Verdict::Verified);
		run(claim_call("ada"), signed(OWNER)).succeeded();

		// Before the identity is read: an invalid name, a name already held, not signed.
		run(claim_call("Ada"), signed(OWNER))
			.failed_with(Error::<Test>::NameInvalidChar)
			.reported(early)
			.tiny();
		run(claim_call("bob"), signed(OWNER))
			.failed_with(Error::<Test>::AlreadyHasName)
			.reported(early)
			.tiny();
		let unsigned = run(claim_call("bob"), RuntimeOrigin::root());
		assert_eq!(unsigned.error, Some(DispatchError::BadOrigin));
		unsigned.reported(early).tiny();

		// The cooldown after a release.
		assert_ok!(Identitee::release_username(signed(OWNER)));
		run(claim_call("bob"), signed(OWNER))
			.failed_with(Error::<Test>::ClaimCooldown)
			.reported(early)
			.tiny();
	});
}

#[test]
fn claim_name_that_fails_after_the_identity_reports_what_it_read() {
	ext().execute_with(|| {
		// No identity: the checks that read the identity and the name state, no scan.
		run(claim_call("ada"), signed(OWNER))
			.failed_with(Error::<Test>::NoIdentity)
			.reported(Weights::claim_username_actual(0, false));

		// An identity with one unattested field: one read finds there is nothing to scan.
		put(OWNER, FieldKey::Typed(FieldKind::Email), b"a@x.org".to_vec());
		run(claim_call("ada"), signed(OWNER))
			.failed_with(Error::<Test>::NoVerifiedField)
			.reported(Weights::claim_username_actual(1, false));
		assert!(Weights::claim_username_early().all_lt(Weights::claim_username_actual(0, false)));
	});
}

#[test]
fn claim_name_reports_the_attestations_it_read() {
	ext().execute_with(|| {
		let email = FieldKey::Typed(FieldKind::Email);
		put(OWNER, email.clone(), b"a@x.org".to_vec());
		put(OWNER, custom(0), b"v".to_vec());
		assert_ok!(Identitee::add_link(
			RuntimeOrigin::signed(OWNER),
			LinkTitle::try_from(b"t".to_vec()).unwrap(),
			value(b"u".to_vec())
		));
		// The email: two rejections. The custom field: one. The link: verified by one.
		attest(0, OWNER, &email, Verdict::Rejected);
		attest(1, OWNER, &email, Verdict::Rejected);
		attest(0, OWNER, &custom(0), Verdict::Rejected);
		attest(0, OWNER, &FieldKey::Link(0), Verdict::Verified);

		// Three fields looked at: (2 + 1) + (1 + 1) + (1 + 1) reads, then the name is written.
		run(claim_call("ada"), signed(OWNER))
			.succeeded()
			.reported(Weights::claim_username_actual(7, true));
	});
}

#[test]
fn claim_name_stops_reading_at_the_first_verified_field() {
	ext().execute_with(|| {
		let email = FieldKey::Typed(FieldKind::Email);
		put(OWNER, email.clone(), b"a@x.org".to_vec());
		attest(0, OWNER, &email, Verdict::Verified);
		// A custom field with every authority's attestation: never looked at.
		put(OWNER, custom(0), b"v".to_vec());
		for authority in 0..MAX_AUTHORITIES {
			attest(authority, OWNER, &custom(0), Verdict::Rejected);
		}
		run(claim_call("ada"), signed(OWNER))
			.succeeded()
			.reported(Weights::claim_username_actual(2, true));
	});
}

#[test]
fn claim_name_on_the_fullest_identity_stays_within_what_it_declares() {
	// Rejected everywhere but on the last link: the scan reads all 42 fields and 672
	// attestations before it finds the verified one.
	for found in [true, false] {
		ext().execute_with(|| {
			let keys = fill_identity(OWNER);
			let last = keys.last().cloned().unwrap();
			for key in &keys {
				for authority in 0..MAX_AUTHORITIES {
					let verdict =
						if found && *key == last { Verdict::Verified } else { Verdict::Rejected };
					attest(authority, OWNER, key, verdict);
				}
			}
			let fields = keys.len() as u32;
			assert_eq!(fields, KINDS.len() as u32 + MAX_CUSTOM_FIELDS + MAX_LINKS);
			let reads = fields + fields * MAX_AUTHORITIES;
			assert!(reads <= max_scan_reads());

			let dispatched = run(claim_call("ada"), signed(OWNER));
			if found {
				dispatched.succeeded();
			} else {
				dispatched.failed_with(Error::<Test>::NoVerifiedField);
			}
			dispatched.within(Weights::claim_username_actual(reads, found));
		});
	}
}

#[test]
fn declared_weight_of_claim_name_is_the_scan_of_the_fullest_identity() {
	// The declared weight is the worst case the `_actual` function can report, and nothing less.
	let declared = Weights::claim_username();
	assert_eq!(declared, Weights::claim_username_actual(max_scan_reads(), true));
	assert!(Weights::claim_username_actual(max_scan_reads() - 1, true).all_lt(declared));
	// Not claiming saves the writes only: the reads and the proof are the same.
	assert!(
		Weights::claim_username_actual(max_scan_reads(), false).ref_time() < declared.ref_time()
	);
}

// --- accept_sub ---

/// An account that accepts proposals in the tests below.
const SUB: u64 = 50;

fn accept_call(parent: u64) -> crate::Call<Test> {
	crate::Call::accept_sub { parent }
}

fn email_identity(who: u64) {
	put(who, FieldKey::Typed(FieldKind::Email), b"a@x.org".to_vec());
}

/// `parent` (which gets an identity if it has none) proposes `sub`.
fn propose_to(parent: u64, sub: u64) {
	email_identity(parent);
	assert_ok!(Identitee::add_sub(signed(parent), sub, SubLabel::default()));
}

#[test]
fn declared_weight_of_accept_sub_is_the_search_of_a_full_list() {
	assert_eq!(Weights::accept_sub(), Weights::accept_sub_actual(MAX_SUBS));
	assert!(Weights::accept_sub_actual(MAX_SUBS - 1).all_lt(Weights::accept_sub()));
	assert!(Weights::accept_sub_actual(0).all_lt(Weights::accept_sub_actual(1)));
}

#[test]
fn accept_sub_does_not_pay_for_the_proposals_made_to_the_caller() {
	// The same acceptance with no other proposal to the account and with a hundred of them: the
	// weight it reports is the same, and it is the weight of a search of nothing.
	let reported = |others: u64| {
		let mut actual = None;
		ext().execute_with(|| {
			propose_to(OWNER, SUB);
			for other in 0..others {
				propose_to(2000 + other, SUB);
			}
			let dispatched = run(accept_call(OWNER), signed(SUB));
			dispatched.succeeded().reported(Weights::accept_sub_actual(0));
			actual = Some(dispatched.actual);
		});
		actual.unwrap()
	};
	assert_eq!(reported(0), reported(100));
}

#[test]
fn accept_sub_reports_the_subs_it_searched() {
	// SUB lists three proposals and no accepted sub: the three links are read.
	ext().execute_with(|| {
		propose_to(OWNER, SUB);
		email_identity(SUB);
		for sub in [60, 61, 62] {
			propose_to(SUB, sub);
		}
		run(accept_call(OWNER), signed(SUB))
			.succeeded()
			.reported(Weights::accept_sub_actual(3));
	});
	// The search stops at the first accepted sub, the second of three.
	ext().execute_with(|| {
		propose_to(OWNER, SUB);
		for sub in [60, 61, 62] {
			propose_to(SUB, sub);
		}
		assert_ok!(Identitee::accept_sub(signed(61), SUB));
		run(accept_call(OWNER), signed(SUB))
			.failed_with(Error::<Test>::SubIsParent)
			.reported(Weights::accept_sub_actual(2));
	});
}

#[test]
fn accept_sub_that_fails_before_the_search_reports_no_search() {
	ext().execute_with(|| {
		let early = Weights::accept_sub_actual(0);
		email_identity(OWNER);
		run(accept_call(OWNER), signed(SUB))
			.failed_with(Error::<Test>::NoSuchProposal)
			.reported(early);
		let unsigned = run(accept_call(OWNER), RuntimeOrigin::root());
		assert_eq!(unsigned.error, Some(DispatchError::BadOrigin));
		unsigned.reported(early);

		// The caller has a parent already: the proposal of another is refused.
		propose_to(OWNER, SUB);
		propose_to(2000, SUB);
		assert_ok!(Identitee::accept_sub(signed(SUB), 2000));
		run(accept_call(OWNER), signed(SUB))
			.failed_with(Error::<Test>::AlreadyHasParent)
			.reported(early);
	});
	ext().execute_with(|| {
		let early = Weights::accept_sub_actual(0);
		// The proposer became a sub of someone else.
		propose_to(OWNER, SUB);
		propose_to(2000, OWNER);
		assert_ok!(Identitee::accept_sub(signed(OWNER), 2000));
		run(accept_call(OWNER), signed(SUB))
			.failed_with(Error::<Test>::ParentIsSub)
			.reported(early);
	});
}

#[test]
fn accept_sub_with_the_fullest_list_stays_within_what_it_declares() {
	ext().execute_with(|| {
		propose_to(OWNER, SUB);
		email_identity(SUB);
		for i in 0..MAX_SUBS {
			propose_to(SUB, 3000 + u64::from(i));
		}
		run(accept_call(OWNER), signed(SUB))
			.succeeded()
			.within(Weights::accept_sub_actual(MAX_SUBS));
	});
}

// --- clear_identity and kill_identity ---

#[test]
fn clearing_a_missing_identity_reports_a_tiny_weight() {
	ext().execute_with(|| {
		let early = Weights::clear_identity_early();
		let clear = crate::Call::<Test>::clear_identity {};
		run(clear.clone(), signed(OWNER))
			.failed_with(Error::<Test>::NoIdentity)
			.reported(early)
			.tiny();
		let unsigned = run(clear, RuntimeOrigin::root());
		assert_eq!(unsigned.error, Some(DispatchError::BadOrigin));
		unsigned.reported(early).tiny();

		let force = crate::Call::<Test>::kill_identity { who: OWNER };
		run(force.clone(), RuntimeOrigin::root())
			.failed_with(Error::<Test>::NoIdentity)
			.reported(early)
			.tiny();
		let not_root = run(force, signed(OWNER));
		assert_eq!(not_root.error, Some(DispatchError::BadOrigin));
		not_root.reported(early).tiny();
	});
}

/// Runs `setup`, then writes its changes to the database: the keys a call deletes are counted
/// from the database, not from the changes of the block in progress (which cost it no read).
fn settled(setup: impl FnOnce()) -> sp_io::TestExternalities {
	let mut ext = ext();
	ext.execute_with(setup);
	ext.commit_all().expect("the state commits");
	ext
}

fn grant(authority: u32, kind: FactKind) {
	assert_ok!(Identitee::grant_fact(
		signed(agent(authority)),
		OWNER,
		kind,
		None,
		ReasonCode::Unspecified,
		Note::default()
	));
}

fn claim(who: u64, text: &str) {
	assert_ok!(Identitee::claim_username(
		signed(who),
		Name::try_from(text.as_bytes().to_vec()).unwrap()
	));
}

#[test]
fn clear_identity_of_a_bare_identity_reports_just_the_identity() {
	let mut ext = settled(|| put(OWNER, FieldKey::Typed(FieldKind::Email), b"a@x.org".to_vec()));
	ext.execute_with(|| {
		run(crate::Call::clear_identity {}, signed(OWNER))
			.succeeded()
			.reported(Weights::clear_identity_actual(Cleared::default()));
	});
}

#[test]
fn clear_identity_reports_what_it_deleted() {
	let email = FieldKey::Typed(FieldKind::Email);
	let mut ext = settled(|| {
		// One attestation, a name, one request and one fact.
		put(OWNER, email.clone(), b"a@x.org".to_vec());
		attest(0, OWNER, &email, Verdict::Verified);
		claim(OWNER, "ada");
		grant(0, FactKind::DocumentChecked);
		assert_ok!(Identitee::request_judgement(
			signed(OWNER),
			1,
			Target::Fact(FactKind::DocumentChecked)
		));
	});
	ext.execute_with(|| {
		// The fact stays with the person: not counted.
		let cleared = Cleared { attestations: 1, requests: 1, name: true, ..Cleared::default() };
		run(crate::Call::clear_identity {}, signed(OWNER))
			.succeeded()
			.reported(Weights::clear_identity_actual(cleared));
		assert!(Quarantine::<Test>::contains_key(Name::try_from(b"ada".to_vec()).unwrap()));
	});
}

#[test]
fn clear_identity_reports_the_sub_links_it_dropped() {
	let mut ext = settled(|| {
		put(OWNER, FieldKey::Typed(FieldKind::Email), b"a@x.org".to_vec());
		// Two accepted links and a pending one.
		for sub in [10, 11, 12] {
			assert_ok!(Identitee::add_sub(signed(OWNER), sub, SubLabel::default()));
		}
		assert_ok!(Identitee::accept_sub(signed(10), OWNER));
		assert_ok!(Identitee::accept_sub(signed(11), OWNER));
	});
	ext.execute_with(|| {
		let cleared = Cleared { subs: 3, ..Cleared::default() };
		run(crate::Call::clear_identity {}, signed(OWNER))
			.succeeded()
			.reported(Weights::clear_identity_actual(cleared));
	});
	// More links cost more, one at a time.
	assert!(Weights::clear_identity_actual(Cleared::default())
		.all_lt(Weights::clear_identity_actual(Cleared { subs: 1, ..Cleared::default() })));
	assert!(Weights::clear_identity_actual(Cleared { subs: 1, ..Cleared::default() })
		.all_lt(Weights::clear_identity_actual(Cleared { subs: 2, ..Cleared::default() })));
}

#[test]
fn clearing_the_identity_of_a_sub_reports_no_links() {
	// The link of a sub is not dropped when its own identity goes: nothing to report.
	let mut ext = settled(|| {
		put(OWNER, FieldKey::Typed(FieldKind::Email), b"a@x.org".to_vec());
		put(10, FieldKey::Typed(FieldKind::Email), b"b@x.org".to_vec());
		assert_ok!(Identitee::add_sub(signed(OWNER), 10, SubLabel::default()));
		assert_ok!(Identitee::accept_sub(signed(10), OWNER));
	});
	ext.execute_with(|| {
		run(crate::Call::clear_identity {}, signed(10))
			.succeeded()
			.reported(Weights::clear_identity_actual(Cleared::default()));
	});
}

#[test]
fn kill_identity_counts_the_facts_too() {
	let email = FieldKey::Typed(FieldKind::Email);
	let mut ext = settled(|| {
		put(OWNER, email.clone(), b"a@x.org".to_vec());
		attest(0, OWNER, &email, Verdict::Verified);
		for authority in 0..3 {
			grant(authority, FactKind::Fraud);
		}
	});
	ext.execute_with(|| {
		let cleared = Cleared {
			attestations: 1,
			facts: 3,
			history: true,
			secret: true,
			..Cleared::default()
		};
		run(crate::Call::kill_identity { who: OWNER }, RuntimeOrigin::root())
			.succeeded()
			.reported(Weights::clear_identity_actual(cleared));
	});
}

#[test]
fn clearing_the_fullest_identity_stays_within_what_it_declares() {
	for force in [false, true] {
		let mut keys = vec![];
		let mut ext = settled(|| {
			keys = fill_identity(OWNER);
			for key in &keys {
				for authority in 0..MAX_AUTHORITIES {
					attest(authority, OWNER, key, Verdict::Verified);
				}
			}
			claim(OWNER, "ada");
			// Every authority records both kinds of fact, then every authority has a pending
			// request (a request is consumed by the fact it asks for, so these come last).
			for authority in 0..MAX_AUTHORITIES {
				grant(authority, FactKind::DocumentChecked);
				grant(authority, FactKind::Fraud);
				assert_ok!(Identitee::request_judgement(
					signed(OWNER),
					authority,
					Target::Fact(FactKind::DocumentChecked)
				));
			}
			// The most sub-accounts, half of them accepted.
			for i in 0..MAX_SUBS {
				let sub = 1000 + u64::from(i);
				assert_ok!(Identitee::add_sub(signed(OWNER), sub, SubLabel::default()));
				if i % 2 == 0 {
					assert_ok!(Identitee::accept_sub(signed(sub), OWNER));
				}
			}
		});
		ext.execute_with(|| {
			assert_eq!(MAX_AUTHORITIES, MAX_PENDING_REQUESTS);
			let attestations = keys.len() as u32 * MAX_AUTHORITIES;
			let facts = if force { FactKind::COUNT * MAX_AUTHORITIES } else { 0 };
			let cleared = Cleared {
				attestations,
				requests: MAX_PENDING_REQUESTS,
				facts,
				name: true,
				subs: MAX_SUBS,
				history: force,
				secret: force,
			};
			let dispatched = if force {
				run(crate::Call::kill_identity { who: OWNER }, RuntimeOrigin::root())
			} else {
				run(crate::Call::clear_identity {}, signed(OWNER))
			};
			dispatched.succeeded().within(Weights::clear_identity_actual(cleared));
		});
	}
}

#[test]
fn declared_weight_of_the_clearing_calls_is_the_fullest_purge() {
	let all = Cleared {
		attestations: crate::limits::MAX_ATTESTATIONS_PER_IDENTITY,
		requests: MAX_PENDING_REQUESTS,
		facts: FactKind::COUNT * MAX_AUTHORITIES,
		name: true,
		subs: MAX_SUBS,
		history: true,
		secret: true,
	};
	assert_eq!(Weights::clear_identity(), Weights::clear_identity_actual(all));
	for smaller in [
		Cleared { name: false, ..all },
		Cleared { facts: all.facts - 1, ..all },
		Cleared { requests: all.requests - 1, ..all },
		Cleared { attestations: all.attestations - 1, ..all },
		Cleared { subs: all.subs - 1, ..all },
		Cleared { history: false, ..all },
		Cleared { secret: false, ..all },
	] {
		assert!(Weights::clear_identity_actual(smaller).all_lt(Weights::clear_identity()));
	}
}

// --- set_identity ---

fn set_identity_call(changes: Vec<(FieldKey, Option<FieldValue>)>) -> crate::Call<Test> {
	crate::Call::set_identity { changes: FieldChanges::try_from(changes).unwrap() }
}

fn set_to(key: FieldKey) -> (FieldKey, Option<FieldValue>) {
	(key, Some(FieldValue::Public(value(b"v".to_vec()))))
}

#[test]
fn set_fields_declares_the_worst_case_of_its_changes() {
	// 32 changes, each as heavy as the heavier of a set and a clear (a clear also deletes the
	// attestations of the field).
	let per_change = Weights::set_field().max(Weights::clear_field());
	assert_eq!(Weights::set_identity(), per_change.saturating_mul(u64::from(MAX_FIELD_CHANGES)));
	assert_eq!(Weights::set_identity_actual(MAX_FIELD_CHANGES), Weights::set_identity());
	let call = set_identity_call(vec![set_to(FieldKey::Typed(FieldKind::Email))]);
	assert_eq!(call.get_dispatch_info().call_weight, Weights::set_identity());
	// Each change adds weight.
	for n in 0..MAX_FIELD_CHANGES {
		assert!(Weights::set_identity_actual(n).all_lt(Weights::set_identity_actual(n + 1)));
	}
}

#[test]
fn set_fields_reports_the_changes_it_applied() {
	ext().execute_with(|| {
		let changes = vec![
			set_to(FieldKey::Typed(FieldKind::Email)),
			set_to(custom(0)),
			(FieldKey::Typed(FieldKind::Web), None),
		];
		// Not signed and no change attempted: nothing but the origin check done.
		let unsigned = run(set_identity_call(changes.clone()), RuntimeOrigin::root());
		assert_eq!(unsigned.error, Some(DispatchError::BadOrigin));
		unsigned.reported(Weights::set_identity_actual(0)).tiny();

		run(set_identity_call(changes), signed(OWNER))
			.succeeded()
			.reported(Weights::set_identity_actual(3));

		// A full call, 32 different keys, reports exactly what it declared.
		let mut full: Vec<_> = KINDS
			.iter()
			.map(|kind| match kind {
				FieldKind::Pgp => {
					(FieldKey::Typed(FieldKind::Pgp), Some(FieldValue::Public(value(vec![7; 20]))))
				},
				kind => set_to(FieldKey::Typed(*kind)),
			})
			.collect();
		full.extend((0..MAX_CUSTOM_FIELDS).map(|i| set_to(custom(i))));
		full.extend((100..106).map(|i| (custom(i), None)));
		assert_eq!(full.len(), MAX_FIELD_CHANGES as usize);
		let full = run(set_identity_call(full), signed(2));
		full.succeeded().within(Weights::set_identity_actual(MAX_FIELD_CHANGES));
		assert_eq!(full.actual, full.declared);
	});
}

#[test]
fn set_fields_that_fails_reports_the_changes_it_started() {
	ext().execute_with(|| {
		// Twice the same key: refused before any change is made.
		let email = FieldKey::Typed(FieldKind::Email);
		run(set_identity_call(vec![set_to(email.clone()), set_to(email.clone())]), signed(OWNER))
			.failed_with(Error::<Test>::DuplicateFieldInBatch)
			.reported(Weights::set_identity_actual(0))
			.tiny();

		// The third change is invalid: three were started, none is kept.
		let bad_pgp =
			(FieldKey::Typed(FieldKind::Pgp), Some(FieldValue::Public(value(vec![1; 19]))));
		run(
			set_identity_call(vec![set_to(email), set_to(custom(0)), bad_pgp, set_to(custom(1))]),
			signed(OWNER),
		)
		.failed_with(Error::<Test>::InvalidPgp)
		.reported(Weights::set_identity_actual(3));
		assert!(crate::Identities::<Test>::get(OWNER).is_none());
	});
}

// --- identity secret ---

#[test]
fn identity_secret_calls_declare_their_own_weight() {
	let set = crate::Call::<Test>::set_identity_secret { blob: Default::default() };
	assert_eq!(set.get_dispatch_info().call_weight, Weights::set_identity_secret());
	let clear = crate::Call::<Test>::clear_identity_secret {};
	assert_eq!(clear.get_dispatch_info().call_weight, Weights::clear_identity_secret());
	// The proof covers the largest blob, and the database accesses are charged.
	assert!(Weights::set_identity_secret().proof_size() > u64::from(MAX_SECRET_BLOB_LEN));
	assert!(Weights::set_identity_secret().ref_time() > 50_000_000);
	// A purge that deletes the secret weighs more than one that does not.
	let with_secret = Cleared { secret: true, ..Cleared::default() };
	assert!(Weights::clear_identity_actual(Cleared::default())
		.all_lt(Weights::clear_identity_actual(with_secret)));
}
