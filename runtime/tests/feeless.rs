//! Integration tests for feeless writes from never-funded accounts.
//!
//! These tests build the real runtime state from the `development` genesis preset, sign real
//! extrinsics and apply them through `Executive::apply_extrinsic`, so they exercise the full
//! transaction extension pipeline exactly as a block author would.

use codec::{Decode, Encode};
use frame_support::BoundedVec;
use identitee_runtime::{
	extensions::CheckNonceOnboard, Balances, BalancesCall, Executive, Header, Runtime, RuntimeCall,
	RuntimeGenesisConfig, SignedPayload, System, TxExtension, UncheckedExtrinsic,
};
use sp_core::{sr25519, Pair};
use sp_runtime::{
	generic::Era,
	traits::{Header as _, TransactionExtension},
	transaction_validity::{InvalidTransaction, TransactionValidityError},
	AccountId32, BuildStorage, DispatchError, MultiSignature,
};

/// Recursively merges a genesis preset patch into a full genesis config JSON value.
fn merge(base: &mut serde_json::Value, patch: serde_json::Value) {
	match (base, patch) {
		(serde_json::Value::Object(base), serde_json::Value::Object(patch)) => {
			for (key, value) in patch {
				merge(base.entry(key).or_insert(serde_json::Value::Null), value);
			}
		},
		(base, patch) => *base = patch,
	}
}

/// Externalities built from the runtime's `development` preset, with block 1 initialized.
fn new_ext() -> sp_io::TestExternalities {
	let preset = identitee_runtime::genesis_config_presets::get_preset(
		&sp_genesis_builder::DEV_RUNTIME_PRESET.into(),
	)
	.expect("development preset exists");
	let patch: serde_json::Value = serde_json::from_slice(&preset).expect("valid preset JSON");
	let mut config =
		serde_json::to_value(RuntimeGenesisConfig::default()).expect("default config serializes");
	merge(&mut config, patch);
	let config: RuntimeGenesisConfig =
		serde_json::from_value(config).expect("merged config deserializes");
	let storage = config.build_storage().expect("genesis storage builds");

	let mut ext = sp_io::TestExternalities::new(storage);
	ext.execute_with(|| {
		let parent = System::block_hash(0);
		Executive::initialize_block(&Header::new(
			1,
			Default::default(),
			Default::default(),
			parent,
			Default::default(),
		));
	});
	ext
}

fn account(pair: &sr25519::Pair) -> AccountId32 {
	AccountId32::from(pair.public())
}

/// A fresh sr25519 key that has never been funded.
fn fresh_pair() -> sr25519::Pair {
	sr25519::Pair::generate().0
}

fn tx_ext(nonce: u32) -> TxExtension {
	(
		frame_system::AuthorizeCall::<Runtime>::new(),
		frame_system::CheckNonZeroSender::<Runtime>::new(),
		frame_system::CheckSpecVersion::<Runtime>::new(),
		frame_system::CheckTxVersion::<Runtime>::new(),
		frame_system::CheckGenesis::<Runtime>::new(),
		frame_system::CheckEra::<Runtime>::from(Era::Immortal),
		CheckNonceOnboard::<Runtime>::from(nonce),
		frame_system::CheckWeight::<Runtime>::new(),
		pallet_skip_feeless_payment::SkipCheckIfFeeless::from(
			pallet_transaction_payment::ChargeTransactionPayment::<Runtime>::from(0),
		),
		frame_metadata_hash_extension::CheckMetadataHash::<Runtime>::new(false),
		frame_system::WeightReclaim::<Runtime>::new(),
	)
}

/// Signs `call` with `pair` at `nonce`. Must run inside externalities (the implicit data reads
/// the genesis hash and runtime version from state).
fn signed(pair: &sr25519::Pair, call: RuntimeCall, nonce: u32) -> UncheckedExtrinsic {
	let ext = tx_ext(nonce);
	let payload = SignedPayload::new(call.clone(), ext.clone()).expect("implicit data available");
	let signature = payload.using_encoded(|bytes| pair.sign(bytes));
	UncheckedExtrinsic::new_signed(
		call,
		account(pair).into(),
		MultiSignature::Sr25519(signature),
		ext,
	)
}

fn set_bio(bio: &[u8]) -> RuntimeCall {
	RuntimeCall::Identitee(pallet_identitee::Call::set_bio {
		bio: BoundedVec::try_from(bio.to_vec()).expect("bio within bounds"),
	})
}

#[test]
fn zero_balance_account_can_set_bio() {
	new_ext().execute_with(|| {
		let pair = fresh_pair();
		let who = account(&pair);
		assert_eq!(System::providers(&who), 0);

		let result = Executive::apply_extrinsic(signed(&pair, set_bio(b"hello"), 0));
		assert_eq!(result, Ok(Ok(())));

		assert_eq!(System::account_nonce(&who), 1);
		assert_eq!(Balances::free_balance(&who), 0);
		assert_eq!(System::providers(&who), 1);
		assert!(pallet_identitee::ProviderHeld::<Runtime>::contains_key(&who));
		let identity =
			pallet_identitee::Identities::<Runtime>::get(&who).expect("identity created");
		assert_eq!(identity.bio.to_vec(), b"hello".to_vec());
	});
}

#[test]
fn zero_balance_account_can_set_several_fields_in_one_call() {
	use pallet_identitee::types::{FieldChanges, FieldKey, FieldKind, FieldValue};
	use sp_core::H256;
	new_ext().execute_with(|| {
		let pair = fresh_pair();
		let who = account(&pair);
		let public = |v: &[u8]| FieldValue::Public(v.to_vec().try_into().expect("within bounds"));
		let set_identity = |changes: Vec<(FieldKey, Option<FieldValue>)>| {
			RuntimeCall::Identitee(pallet_identitee::Call::set_identity {
				changes: FieldChanges::try_from(changes).expect("within bounds"),
			})
		};
		let email = FieldKey::Typed(FieldKind::Email);
		let pronouns = FieldKey::Custom(b"pronoms".to_vec().try_into().expect("within bounds"));
		let telegram = FieldKey::Typed(FieldKind::Telegram);

		// Three changes in one transaction, feeless from an account that never had a balance.
		let call = set_identity(vec![
			(email.clone(), Some(public(b"a@x.org"))),
			(pronouns.clone(), Some(public(b"il"))),
			(telegram.clone(), Some(FieldValue::Private(H256::repeat_byte(7)))),
		]);
		let result = Executive::apply_extrinsic(signed(&pair, call, 0));
		assert_eq!(result, Ok(Ok(())));
		assert_eq!(System::account_nonce(&who), 1);
		assert_eq!(Balances::free_balance(&who), 0);
		assert_eq!(System::providers(&who), 1);
		let identity =
			pallet_identitee::Identities::<Runtime>::get(&who).expect("identity created");
		assert_eq!((identity.typed.len(), identity.custom.len()), (2, 1));
		// One call is one quota unit, whatever the number of changes.
		assert_eq!(pallet_identitee::Usage::<Runtime>::get(&who), Some((1, 1)));

		// Clearing and setting in one call, the same way.
		let call = set_identity(vec![(email, None), (telegram, Some(public(b"@x")))]);
		assert_eq!(Executive::apply_extrinsic(signed(&pair, call, 1)), Ok(Ok(())));
		let identity = pallet_identitee::Identities::<Runtime>::get(&who).expect("identity");
		assert_eq!(identity.typed.len(), 1);
		assert_eq!(pallet_identitee::Usage::<Runtime>::get(&who), Some((1, 2)));
		assert_eq!(Balances::free_balance(&who), 0);
	});
}

#[test]
fn zero_balance_account_can_store_its_identity_secret() {
	use identitee_runtime::AccountId;
	use pallet_identitee::runtime_api::runtime_decl_for_identitee_api::IdentiteeApiV1;
	new_ext().execute_with(|| {
		let pair = fresh_pair();
		let who = account(&pair);
		let set = |bytes: &[u8]| {
			RuntimeCall::Identitee(pallet_identitee::Call::set_identity_secret {
				blob: bytes.to_vec().try_into().expect("within bounds"),
			})
		};
		let api =
			|who: &AccountId| state_call::<Option<Vec<u8>>>("IdentiteeApi_identity_secret", who);
		assert_eq!(api(&who), None);

		// Feeless from an account that never had a balance, and no identity is needed.
		let result = Executive::apply_extrinsic(signed(&pair, set(b"v1|salt|nonce|ciphertext"), 0));
		assert_eq!(result, Ok(Ok(())));
		assert_eq!(System::account_nonce(&who), 1);
		assert_eq!(Balances::free_balance(&who), 0);
		assert_eq!(System::providers(&who), 1);
		assert!(pallet_identitee::Identities::<Runtime>::get(&who).is_none());
		// One quota unit.
		assert_eq!(pallet_identitee::Usage::<Runtime>::get(&who), Some((1, 1)));

		// The runtime API returns the blob, through the dispatcher and through the trait.
		assert_eq!(api(&who), Some(b"v1|salt|nonce|ciphertext".to_vec()));
		assert_eq!(
			Runtime::identity_secret(who.clone()),
			Some(b"v1|salt|nonce|ciphertext".to_vec())
		);

		// Overwritten, then cleared, each a quota unit.
		assert_eq!(Executive::apply_extrinsic(signed(&pair, set(b"v1|other"), 1)), Ok(Ok(())));
		assert_eq!(api(&who), Some(b"v1|other".to_vec()));
		let clear = RuntimeCall::Identitee(pallet_identitee::Call::clear_identity_secret {});
		assert_eq!(Executive::apply_extrinsic(signed(&pair, clear, 2)), Ok(Ok(())));
		assert_eq!(api(&who), None);
		assert_eq!(pallet_identitee::Usage::<Runtime>::get(&who), Some((1, 3)));
		assert_eq!(Balances::free_balance(&who), 0);

		// An empty blob is refused by the pallet, and the failed call still counts.
		let result = Executive::apply_extrinsic(signed(&pair, set(b""), 3));
		let expected: DispatchError = pallet_identitee::Error::<Runtime>::EmptySecretBlob.into();
		assert_eq!(result, Ok(Err(expected)));
		assert_eq!(api(&who), None);
	});
}

#[test]
fn zero_balance_account_can_update_its_whole_profile_in_one_call() {
	use pallet_identitee::types::{
		FieldChanges, FieldKey, FieldKind, FieldValue, LinkEdit, ProfileUpdate,
	};
	use sp_core::H256;
	new_ext().execute_with(|| {
		let pair = fresh_pair();
		let who = account(&pair);
		fn bounded<B: TryFrom<Vec<u8>>>(v: &[u8]) -> B {
			B::try_from(v.to_vec()).ok().expect("within bounds")
		}
		let update = ProfileUpdate {
			bio: Some(bounded(b"hello")),
			avatar: None,
			fields: FieldChanges::try_from(vec![
				(FieldKey::Typed(FieldKind::Email), Some(FieldValue::Public(bounded(b"a@x.org")))),
				(
					FieldKey::Typed(FieldKind::LegalName),
					Some(FieldValue::Private(H256::repeat_byte(7))),
				),
			])
			.expect("within bounds"),
			links: Some(
				vec![LinkEdit::Add { title: bounded(b"site"), url: bounded(b"https://x.org") }]
					.try_into()
					.expect("within bounds"),
			),
			secret: Some(bounded(b"v1|salt|nonce|ciphertext")),
		};
		let call = RuntimeCall::Identitee(pallet_identitee::Call::update_profile { update });

		// Feeless from an account that never had a balance.
		assert_eq!(Executive::apply_extrinsic(signed(&pair, call, 0)), Ok(Ok(())));
		assert_eq!(System::account_nonce(&who), 1);
		assert_eq!(Balances::free_balance(&who), 0);
		assert_eq!(System::providers(&who), 1);
		let identity =
			pallet_identitee::Identities::<Runtime>::get(&who).expect("identity created");
		assert_eq!(identity.bio.to_vec(), b"hello".to_vec());
		assert_eq!((identity.typed.len(), identity.links.len()), (2, 1));
		assert!(pallet_identitee::IdentitySecrets::<Runtime>::contains_key(&who));
		// One call is one quota unit, whatever it changes, and one feeless call of the block.
		assert_eq!(pallet_identitee::Usage::<Runtime>::get(&who), Some((1, 1)));
		assert_eq!(pallet_identitee::BlockFeelessOps::<Runtime>::get(), 1);

		// A refused update counts too, and changes nothing.
		let empty = RuntimeCall::Identitee(pallet_identitee::Call::update_profile {
			update: ProfileUpdate::default(),
		});
		let expected: DispatchError = pallet_identitee::Error::<Runtime>::EmptyUpdate.into();
		assert_eq!(Executive::apply_extrinsic(signed(&pair, empty, 1)), Ok(Err(expected)));
		assert_eq!(pallet_identitee::Usage::<Runtime>::get(&who), Some((1, 2)));
		assert_eq!(pallet_identitee::Identities::<Runtime>::get(&who), Some(identity));
		assert_eq!(Balances::free_balance(&who), 0);
	});
}

#[test]
fn zero_balance_account_cannot_transfer() {
	new_ext().execute_with(|| {
		let pair = fresh_pair();
		let who = account(&pair);
		let dest = sp_keyring::Sr25519Keyring::Bob.to_account_id();
		let call = RuntimeCall::Balances(BalancesCall::transfer_keep_alive {
			dest: dest.into(),
			value: 1,
		});

		let result = Executive::apply_extrinsic(signed(&pair, call, 0));
		assert_eq!(result, Err(TransactionValidityError::Invalid(InvalidTransaction::Payment)));
		assert_eq!(System::providers(&who), 0);
		assert_eq!(System::account_nonce(&who), 0);
		assert!(!pallet_identitee::ProviderHeld::<Runtime>::contains_key(&who));
	});
}

#[test]
fn failed_first_call_leaves_account_usable() {
	new_ext().execute_with(|| {
		let pair = fresh_pair();
		let who = account(&pair);

		let result = Executive::apply_extrinsic(signed(&pair, set_bio(&[0xff, 0xfe, 0xfd]), 0));
		let expected: DispatchError = pallet_identitee::Error::<Runtime>::InvalidUtf8.into();
		assert_eq!(result, Ok(Err(expected)));
		assert_eq!(System::account_nonce(&who), 1);
		assert!(pallet_identitee::Identities::<Runtime>::get(&who).is_none());

		let result = Executive::apply_extrinsic(signed(&pair, set_bio(b"ok"), 1));
		assert_eq!(result, Ok(Ok(())));
		assert_eq!(System::account_nonce(&who), 2);
		assert_eq!(System::providers(&who), 1, "onboarding happens once");
		assert_eq!(Balances::free_balance(&who), 0);
	});
}

#[test]
fn tx_extension_identifiers_match_upstream() {
	let identifiers: Vec<String> = <TxExtension as TransactionExtension<RuntimeCall>>::metadata()
		.into_iter()
		.map(|m| m.identifier.to_string())
		.collect();
	// Exactly the list of the Polkadot SDK solochain template (stable2606-3), so wallets need no
	// custom types.
	assert_eq!(
		identifiers,
		vec![
			"AuthorizeCall",
			"CheckNonZeroSender",
			"CheckSpecVersion",
			"CheckTxVersion",
			"CheckGenesis",
			"CheckMortality",
			"CheckNonce",
			"CheckWeight",
			"ChargeTransactionPayment",
			"CheckMetadataHash",
			"WeightReclaim",
		]
	);

	// Same identifiers in every runtime metadata version a wallet may read (V14, V15, V16).
	for version in [14u32, 15, 16] {
		let opaque = Runtime::metadata_at_version(version).expect("metadata version supported");
		let prefixed = frame_metadata::RuntimeMetadataPrefixed::decode(&mut &opaque[..])
			.expect("metadata decodes");
		let from_metadata: Vec<String> = match prefixed.1 {
			frame_metadata::RuntimeMetadata::V14(m) => {
				m.extrinsic.signed_extensions.iter().map(|e| e.identifier.clone()).collect()
			},
			frame_metadata::RuntimeMetadata::V15(m) => {
				m.extrinsic.signed_extensions.iter().map(|e| e.identifier.clone()).collect()
			},
			frame_metadata::RuntimeMetadata::V16(m) => m
				.extrinsic
				.transaction_extensions
				.iter()
				.map(|e| e.identifier.clone())
				.collect(),
			_ => panic!("unexpected metadata version"),
		};
		assert_eq!(from_metadata, identifiers, "metadata V{version}");
	}
}

#[test]
fn check_nonce_onboard_encodes_like_check_nonce() {
	for nonce in [0u32, 1, 63, 64, 16_383, 16_384, u32::MAX] {
		assert_eq!(
			CheckNonceOnboard::<Runtime>::from(nonce).encode(),
			frame_system::CheckNonce::<Runtime>::from(nonce).encode()
		);
	}
	// The explicit type exposed in metadata has the same shape: one compact nonce field.
	let ours = <CheckNonceOnboard<Runtime> as scale_info::TypeInfo>::type_info();
	let upstream = <frame_system::CheckNonce<Runtime> as scale_info::TypeInfo>::type_info();
	assert_eq!(format!("{:?}", ours.type_def), format!("{:?}", upstream.type_def));
}

#[test]
fn onboarding_is_limited_to_feeless_calls_and_validate_is_read_only() {
	use frame_support::{assert_storage_noop, dispatch::GetDispatchInfo};
	use sp_runtime::traits::DispatchTransaction;

	new_ext().execute_with(|| {
		let who = account(&fresh_pair());
		let origin = identitee_runtime::RuntimeOrigin::signed(who.clone());
		let source = sp_runtime::transaction_validity::TransactionSource::External;

		// Not feeless: the extension itself rejects the never-funded account, like upstream.
		let transfer = RuntimeCall::Balances(BalancesCall::transfer_keep_alive {
			dest: sp_keyring::Sr25519Keyring::Bob.to_account_id().into(),
			value: 1,
		});
		let info = transfer.get_dispatch_info();
		assert_eq!(
			CheckNonceOnboard::<Runtime>::from(0)
				.validate_only(origin.clone(), &transfer, &info, 0, source, 0)
				.map(|_| ()),
			Err(TransactionValidityError::Invalid(InvalidTransaction::Payment))
		);

		// Feeless: accepted, without touching state during validation.
		let call = set_bio(b"x");
		let info = call.get_dispatch_info();
		assert_storage_noop!({
			assert!(CheckNonceOnboard::<Runtime>::from(0)
				.validate_only(origin.clone(), &call, &info, 0, source, 0)
				.is_ok());
		});
		// Prepare onboards the account and bumps the nonce.
		assert!(CheckNonceOnboard::<Runtime>::from(0)
			.validate_and_prepare(origin.clone(), &call, &info, 0, 0)
			.is_ok());
		assert_eq!(System::providers(&who), 1);
		assert_eq!(System::account_nonce(&who), 1);
		// Replaying nonce 0 is stale, as upstream.
		assert_eq!(
			CheckNonceOnboard::<Runtime>::from(0)
				.validate_only(origin, &call, &info, 0, source, 0)
				.map(|_| ()),
			Err(TransactionValidityError::Invalid(InvalidTransaction::Stale))
		);
	});
}

/// Ends block `n` with the identitee hook (the only one with per-block state relevant here) and
/// initializes block `n + 1`. The full `Executive::finalize_block` would need the timestamp
/// inherent.
fn next_block() {
	use frame_support::traits::Hooks;
	let now = System::block_number();
	<pallet_identitee::Pallet<Runtime> as Hooks<_>>::on_finalize(now);
	let parent = System::block_hash(now);
	Executive::initialize_block(&Header::new(
		now + 1,
		Default::default(),
		Default::default(),
		parent,
		Default::default(),
	));
}

const QUOTA: u32 = pallet_identitee::limits::QUOTA_PER_WINDOW;
const GLOBAL_CAP: u32 = pallet_identitee::limits::GLOBAL_FEELESS_PER_BLOCK;

/// Moves to the next block when the current one is full of feeless calls, so that a run of
/// feeless calls longer than the per-block cap (the quota is larger) stays within one window.
fn room_for_a_feeless_call() {
	if pallet_identitee::BlockFeelessOps::<Runtime>::get() >= GLOBAL_CAP {
		next_block();
	}
}

#[test]
fn quota_exhausted_tx_is_invalid() {
	new_ext().execute_with(|| {
		let pair = fresh_pair();
		let who = account(&pair);
		for nonce in 0..QUOTA {
			room_for_a_feeless_call();
			let result = Executive::apply_extrinsic(signed(&pair, set_bio(b"hi"), nonce));
			assert_eq!(result, Ok(Ok(())), "call {nonce}");
		}
		assert_eq!(System::account_nonce(&who), QUOTA);

		room_for_a_feeless_call();
		let result = Executive::apply_extrinsic(signed(&pair, set_bio(b"one more"), QUOTA));
		assert_eq!(result, Err(TransactionValidityError::Invalid(InvalidTransaction::Payment)));
		assert_eq!(System::account_nonce(&who), QUOTA, "nonce unchanged");
		assert_eq!(Balances::free_balance(&who), 0);
		assert_eq!(pallet_identitee::Usage::<Runtime>::get(&who), Some((1, QUOTA)));
	});
}

#[test]
fn failed_calls_consume_quota() {
	new_ext().execute_with(|| {
		let pair = fresh_pair();
		let who = account(&pair);
		let invalid: DispatchError = pallet_identitee::Error::<Runtime>::InvalidUtf8.into();
		for nonce in 0..QUOTA {
			room_for_a_feeless_call();
			let result = Executive::apply_extrinsic(signed(&pair, set_bio(&[0xff]), nonce));
			assert_eq!(result, Ok(Err(invalid)), "call {nonce}");
		}
		assert!(pallet_identitee::Identities::<Runtime>::get(&who).is_none());

		room_for_a_feeless_call();
		let result = Executive::apply_extrinsic(signed(&pair, set_bio(b"valid"), QUOTA));
		assert_eq!(result, Err(TransactionValidityError::Invalid(InvalidTransaction::Payment)));
		assert_eq!(System::account_nonce(&who), QUOTA);
	});
}

#[test]
fn funded_account_pays_once_quota_is_exhausted() {
	new_ext().execute_with(|| {
		let pair = sp_keyring::Sr25519Keyring::Alice.pair();
		let who = account(&pair);
		let start = System::account_nonce(&who);
		let balance = Balances::free_balance(&who);
		for i in 0..QUOTA {
			room_for_a_feeless_call();
			let result = Executive::apply_extrinsic(signed(&pair, set_bio(b"hi"), start + i));
			assert_eq!(result, Ok(Ok(())));
		}
		assert_eq!(Balances::free_balance(&who), balance, "feeless calls are free");

		room_for_a_feeless_call();
		let result = Executive::apply_extrinsic(signed(&pair, set_bio(b"paid"), start + QUOTA));
		assert_eq!(result, Ok(Ok(())));
		assert!(Balances::free_balance(&who) < balance, "the call over quota paid a fee");
		// A paid call is not counted.
		assert_eq!(pallet_identitee::Usage::<Runtime>::get(&who), Some((1, QUOTA)));
	});
}

#[test]
fn global_cap_defers_feeless_calls_to_the_next_block() {
	new_ext().execute_with(|| {
		for _ in 0..GLOBAL_CAP {
			let result = Executive::apply_extrinsic(signed(&fresh_pair(), set_bio(b"hi"), 0));
			assert_eq!(result, Ok(Ok(())));
		}
		assert_eq!(pallet_identitee::BlockFeelessOps::<Runtime>::get(), GLOBAL_CAP);

		// The block is full of feeless calls: the next one is deferred, not dropped, and leaves
		// no state behind.
		let pair = fresh_pair();
		let who = account(&pair);
		let result = Executive::apply_extrinsic(signed(&pair, set_bio(b"late"), 0));
		assert_eq!(
			result,
			Err(TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources))
		);
		assert_eq!(System::providers(&who), 0);
		assert_eq!(System::account_nonce(&who), 0);
		assert!(pallet_identitee::Usage::<Runtime>::get(&who).is_none());

		next_block();
		let result = Executive::apply_extrinsic(signed(&pair, set_bio(b"late"), 0));
		assert_eq!(result, Ok(Ok(())));
	});
}

#[test]
fn pool_validation_after_a_full_block_accepts_feeless_calls() {
	use sp_runtime::transaction_validity::TransactionSource;
	new_ext().execute_with(|| {
		for _ in 0..GLOBAL_CAP {
			let result = Executive::apply_extrinsic(signed(&fresh_pair(), set_bio(b"hi"), 0));
			assert_eq!(result, Ok(Ok(())));
		}
		// The pool validates against the final state of the best block, without running
		// `on_initialize`: the per-block counter must already be cleared there.
		<pallet_identitee::Pallet<Runtime> as frame_support::traits::Hooks<_>>::on_finalize(1);
		let xt = signed(&fresh_pair(), set_bio(b"hi"), 0);
		let validity =
			Executive::validate_transaction(TransactionSource::External, xt, System::block_hash(0));
		assert!(validity.is_ok(), "{validity:?}");
	});
}

#[test]
fn future_nonce_onboarding_leaves_no_state() {
	new_ext().execute_with(|| {
		let pair = fresh_pair();
		let who = account(&pair);
		let result = Executive::apply_extrinsic(signed(&pair, set_bio(b"hi"), 1));
		assert_eq!(result, Err(TransactionValidityError::Invalid(InvalidTransaction::Future)));
		assert_eq!(System::providers(&who), 0);
		assert!(!frame_system::Account::<Runtime>::contains_key(&who));
		assert!(!pallet_identitee::ProviderHeld::<Runtime>::contains_key(&who));
		assert!(pallet_identitee::Usage::<Runtime>::get(&who).is_none());
		assert!(!pallet_identitee::BlockFeelessOps::<Runtime>::exists());
	});
}

#[test]
fn extension_weight_covers_the_quota_for_user_calls_only() {
	use pallet_identitee::WeightInfo;
	let ext = CheckNonceOnboard::<Runtime>::from(0);
	let transfer = RuntimeCall::Balances(BalancesCall::transfer_keep_alive {
		dest: sp_keyring::Sr25519Keyring::Bob.to_account_id().into(),
		value: 1,
	});
	let quota = <Runtime as pallet_identitee::Config>::WeightInfo::note_usage();
	assert!(quota.ref_time() > 0);
	assert_eq!(ext.weight(&set_bio(b"x")), ext.weight(&transfer).saturating_add(quota));
}

// --- Genesis, runtime API, weight refunds ---

const ALICE: sp_keyring::Sr25519Keyring = sp_keyring::Sr25519Keyring::Alice;
const BOB: sp_keyring::Sr25519Keyring = sp_keyring::Sr25519Keyring::Bob;

#[test]
fn genesis_dev_has_identitee_authority() {
	use pallet_identitee::types::{AuthorityInfo, Capabilities};
	new_ext().execute_with(|| {
		assert_eq!(pallet_identitee::NextAuthorityId::<Runtime>::get(), 1);
		assert_eq!(
			pallet_identitee::Authorities::<Runtime>::get(0),
			Some(AuthorityInfo { name: b"identitee".to_vec().try_into().unwrap(), active: true })
		);
		assert_eq!(
			pallet_identitee::Agents::<Runtime>::get(ALICE.to_account_id()),
			Some((0, Capabilities::ALL))
		);
		assert_eq!(
			pallet_identitee::Agents::<Runtime>::get(BOB.to_account_id()),
			Some((0, Capabilities::MIGRATE))
		);
		assert_eq!(pallet_identitee::Agents::<Runtime>::iter().count(), 2);
		// Sudo stays Alice.
		assert_eq!(pallet_sudo::Key::<Runtime>::get(), Some(ALICE.to_account_id()));
	});
}

#[test]
fn local_testnet_preset_has_the_same_authority() {
	let preset = identitee_runtime::genesis_config_presets::get_preset(
		&sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET.into(),
	)
	.expect("local testnet preset exists");
	let patch: serde_json::Value = serde_json::from_slice(&preset).unwrap();
	let authorities = &patch["identitee"]["authorities"];
	assert_eq!(authorities[0]["name"], "identitee");
	assert_eq!(authorities[0]["agents"].as_array().map(Vec::len), Some(2));
}

/// Calls the runtime API method `method` as a node does for `state_call`: by name, with SCALE
/// arguments, through the dispatcher `impl_runtime_apis!` generates.
fn state_call<R: Decode>(method: &str, args: impl Encode) -> R {
	let output = identitee_runtime::apis::api::dispatch(method, &args.encode())
		.unwrap_or_else(|| panic!("{method} is not a runtime API method"));
	R::decode(&mut &output[..]).expect("output decodes")
}

fn set_public(key: pallet_identitee::types::FieldKey, value: &[u8]) -> RuntimeCall {
	RuntimeCall::Identitee(pallet_identitee::Call::set_field {
		key,
		value: pallet_identitee::types::FieldValue::Public(value.to_vec().try_into().unwrap()),
	})
}

#[test]
fn runtime_api_profile_roundtrip() {
	use identitee_runtime::{AccountId, BlockNumber};
	use pallet_identitee::{
		runtime_api::runtime_decl_for_identitee_api::IdentiteeApiV1,
		types::{commitment, FieldKey, FieldKind, FieldValue, Method, TrustLevel, Verdict},
		views::{NameStatus, ProfileView},
	};
	new_ext().execute_with(|| {
		let user_pair = fresh_pair();
		let user = account(&user_pair);
		let email = FieldKey::Typed(FieldKind::Email);
		let github = FieldKey::Typed(FieldKind::GitHub);
		assert_eq!(state_call::<Option<TrustLevel>>("IdentiteeApi_trust_level", &user), None);

		// A never-funded account writes two fields; Alice, agent of "identitee", verifies one.
		for (nonce, (key, value)) in [(email.clone(), &b"a@x.org"[..]), (github, &b"alice-gh"[..])]
			.into_iter()
			.enumerate()
		{
			let call = set_public(key, value);
			assert_eq!(
				Executive::apply_extrinsic(signed(&user_pair, call, nonce as u32)),
				Ok(Ok(()))
			);
		}
		let attest = RuntimeCall::Identitee(pallet_identitee::Call::provide_judgement {
			who: user.clone(),
			key: email.clone(),
			expected_commitment: commitment(&FieldValue::Public(
				b"a@x.org".to_vec().try_into().unwrap(),
			)),
			verdict: Verdict::Verified,
			method: Method::EmailCode,
			expires_at: None,
		});
		let alice = ALICE.pair();
		let alice_nonce = System::account_nonce(account(&alice));
		let alice_balance = Balances::free_balance(account(&alice));
		assert_eq!(Executive::apply_extrinsic(signed(&alice, attest, alice_nonce)), Ok(Ok(())));
		assert_eq!(Balances::free_balance(account(&alice)), alice_balance, "agent call is feeless");

		let profile: Option<ProfileView<AccountId, BlockNumber>> =
			state_call("IdentiteeApi_profile", &user);
		let profile = profile.expect("the user has an identity");
		assert_eq!(profile.trust_level, TrustLevel::PartiallyVerified);
		assert_eq!(profile.identity.typed.len(), 2);
		assert_eq!(profile.attestations.len(), 1);
		let (key, authority, attestation, valid) = &profile.attestations[0];
		assert_eq!(
			(key, *authority, attestation.verdict, *valid),
			(&email, 0, Verdict::Verified, true)
		);
		assert_eq!(profile.name, None);
		assert!(profile.subs.is_empty() && profile.parent.is_none() && profile.imported.is_none());

		assert_eq!(
			state_call::<Option<TrustLevel>>("IdentiteeApi_trust_level", &user),
			Some(TrustLevel::PartiallyVerified)
		);
		// The same answers through the trait the runtime implements.
		assert_eq!(Runtime::trust_level(user.clone()), Some(TrustLevel::PartiallyVerified));
		assert_eq!(Runtime::profile(user.clone()), Some(profile));
		assert_eq!(
			state_call::<NameStatus<AccountId, BlockNumber>>(
				"IdentiteeApi_name_status",
				b"alice".to_vec()
			),
			NameStatus::Available
		);
		assert_eq!(
			state_call::<Option<AccountId>>("IdentiteeApi_resolve_name", b"alice".to_vec()),
			None
		);
		let no_links: Vec<(AccountId, Vec<u8>)> = Vec::new();
		assert_eq!(
			state_call::<Vec<(AccountId, Vec<u8>)>>("IdentiteeApi_subs_of", &user),
			no_links
		);
		assert_eq!(
			state_call::<Vec<(AccountId, Vec<u8>)>>("IdentiteeApi_pending_subs_of", &user),
			no_links
		);
		assert_eq!(
			state_call::<Option<(AccountId, Vec<u8>)>>("IdentiteeApi_parent_of", &user),
			None
		);
	});
}

#[test]
fn refunded_feeless_call_releases_block_weight() {
	use frame_support::{
		dispatch::{DispatchClass, GetDispatchInfo},
		weights::Weight,
	};
	use pallet_identitee::WeightInfo;
	use sp_runtime::traits::TransactionExtension;
	new_ext().execute_with(|| {
		let pair = fresh_pair();
		// Too short: claim_username fails at its first check and reports that little weight.
		let call = RuntimeCall::Identitee(pallet_identitee::Call::claim_username {
			name: b"ab".to_vec().try_into().unwrap(),
		});
		let declared = call.get_dispatch_info().call_weight;
		let actual = <Runtime as pallet_identitee::Config>::WeightInfo::claim_username_early();
		assert!(actual.ref_time() * 10 < declared.ref_time(), "the case is worth a refund");
		let extensions = tx_ext(0).weight(&call);
		let base = <Runtime as frame_system::Config>::BlockWeights::get()
			.get(DispatchClass::Normal)
			.base_extrinsic;

		let before = *System::block_weight().get(DispatchClass::Normal);
		let xt = signed(&pair, call, 0);
		let len = xt.encoded_size() as u64;
		let result = Executive::apply_extrinsic(xt);
		let expected: DispatchError = pallet_identitee::Error::<Runtime>::NameTooShort.into();
		assert_eq!(result, Ok(Err(expected)));
		let used = System::block_weight().get(DispatchClass::Normal).saturating_sub(before);

		// The block keeps the base, the extensions, the length (as proof size) and what the call
		// used, not what it declared.
		let kept = base
			.saturating_add(extensions)
			.saturating_add(Weight::from_parts(0, len))
			.saturating_add(actual);
		assert_eq!(used, kept);
		assert!(used.ref_time() < declared.ref_time());
	});
}
