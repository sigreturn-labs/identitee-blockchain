//! The identitee runtime: a Polkadot SDK solochain whose purpose is the identitee pallet.
//!
//! Besides `pallet_identitee`, it holds the pallets a standalone chain needs: Aura block
//! production, GRANDPA finality, sessions over a validator set managed by root, block rewards,
//! balances, transaction payment (skipped for feeless identity calls, fees to the block author) and
//! sudo. Pallet configuration lives in `configs`, the runtime APIs in `apis`, the transaction
//! extension that lets never-funded accounts write their identity in `extensions`, and upgrade
//! migrations in `migrations`.

#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(feature = "std")]
include!(concat!(env!("OUT_DIR"), "/wasm_binary.rs"));

pub mod apis;
#[cfg(feature = "runtime-benchmarks")]
mod benchmarks;
pub mod configs;
pub mod extensions;
pub mod migrations;

extern crate alloc;
use alloc::vec::Vec;
use sp_runtime::{
	generic, impl_opaque_keys,
	traits::{BlakeTwo256, IdentifyAccount, Verify},
	MultiAddress, MultiSignature,
};
#[cfg(feature = "std")]
use sp_version::NativeVersion;
use sp_version::RuntimeVersion;

pub use frame_system::Call as SystemCall;
pub use pallet_balances::Call as BalancesCall;
pub use pallet_timestamp::Call as TimestampCall;
#[cfg(any(feature = "std", test))]
pub use sp_runtime::BuildStorage;

pub mod genesis_config_presets;

/// Opaque types, used by the node where it does not need to know the specifics of the runtime:
/// it keeps syncing across runtime upgrades that change the extrinsic format.
pub mod opaque {
	use super::*;
	use sp_runtime::{
		generic,
		traits::{BlakeTwo256, Hash as HashT},
	};

	pub use sp_runtime::OpaqueExtrinsic as UncheckedExtrinsic;

	/// Opaque block header type.
	pub type Header = generic::Header<BlockNumber, BlakeTwo256>;
	/// Opaque block type.
	pub type Block = generic::Block<Header, UncheckedExtrinsic>;
	/// Opaque block identifier type.
	pub type BlockId = generic::BlockId<Block>;
	/// Opaque block hash type.
	pub type Hash = <BlakeTwo256 as HashT>::Output;
}

impl_opaque_keys! {
	pub struct SessionKeys {
		pub aura: Aura,
		pub grandpa: Grandpa,
	}
}

#[sp_version::runtime_version]
pub const VERSION: RuntimeVersion = RuntimeVersion {
	spec_name: alloc::borrow::Cow::Borrowed("identitee"),
	impl_name: alloc::borrow::Cow::Borrowed("identitee"),
	authoring_version: 1,
	// Bumped with every runtime upgrade, so nodes and clients see that the logic changed.
	spec_version: 11,
	impl_version: 1,
	apis: apis::RUNTIME_API_VERSIONS,
	transaction_version: 1,
	system_version: 1,
};

mod block_times {
	/// The target block time. Every duration of the runtime that is counted in blocks (quota
	/// window, name quarantine) derives from it.
	pub const MILLI_SECS_PER_BLOCK: u64 = 6000;

	/// The Aura slot duration, read by `pallet_timestamp` and `pallet_aura`. It cannot change
	/// once the chain has started: block production would stop.
	pub const SLOT_DURATION: u64 = MILLI_SECS_PER_BLOCK;
}
pub use block_times::*;

// Durations in blocks.
pub const MINUTES: BlockNumber = 60_000 / (MILLI_SECS_PER_BLOCK as BlockNumber);
pub const HOURS: BlockNumber = MINUTES * 60;
pub const DAYS: BlockNumber = HOURS * 24;

pub const BLOCK_HASH_COUNT: BlockNumber = 2400;

// Balances: one IDT is `UNIT`, twelve decimals.
pub const UNIT: Balance = 1_000_000_000_000;
pub const MILLI_UNIT: Balance = 1_000_000_000;
pub const MICRO_UNIT: Balance = 1_000_000;

/// Existential deposit.
pub const EXISTENTIAL_DEPOSIT: Balance = MILLI_UNIT;

/// The version information used to identify this runtime when compiled natively.
#[cfg(feature = "std")]
pub fn native_version() -> NativeVersion {
	NativeVersion { runtime_version: VERSION, can_author_with: Default::default() }
}

/// The signature of a transaction: sr25519, ed25519 or ecdsa.
pub type Signature = MultiSignature;

/// An account on the chain: the 32-byte public key that signs its transactions.
pub type AccountId = <<Signature as Verify>::Signer as IdentifyAccount>::AccountId;

/// Balance of an account.
pub type Balance = u128;

/// Index of a transaction in the chain.
pub type Nonce = u32;

/// A hash of some data used by the chain.
pub type Hash = sp_core::H256;

/// An index to a block.
pub type BlockNumber = u32;

/// The address format for describing accounts.
pub type Address = MultiAddress<AccountId, ()>;

/// Block header type as expected by this runtime.
pub type Header = generic::Header<BlockNumber, BlakeTwo256>;

/// Block type as expected by this runtime.
pub type Block = generic::Block<Header, UncheckedExtrinsic>;

/// A Block signed with a Justification
pub type SignedBlock = generic::SignedBlock<Block>;

/// BlockId type as expected by this runtime.
pub type BlockId = generic::BlockId<Block>;

/// The `TransactionExtension` to the basic transaction logic.
///
/// The identifiers and encoding of the standard Polkadot SDK set, so wallets need no custom types:
/// `CheckNonceOnboard` presents itself as `CheckNonce`, and `SkipCheckIfFeeless` as the
/// `ChargeTransactionPayment` it wraps.
pub type TxExtension = (
	frame_system::AuthorizeCall<Runtime>,
	frame_system::CheckNonZeroSender<Runtime>,
	frame_system::CheckSpecVersion<Runtime>,
	frame_system::CheckTxVersion<Runtime>,
	frame_system::CheckGenesis<Runtime>,
	frame_system::CheckEra<Runtime>,
	extensions::CheckNonceOnboard<Runtime>,
	frame_system::CheckWeight<Runtime>,
	pallet_skip_feeless_payment::SkipCheckIfFeeless<
		Runtime,
		pallet_transaction_payment::ChargeTransactionPayment<Runtime>,
	>,
	frame_metadata_hash_extension::CheckMetadataHash<Runtime>,
	frame_system::WeightReclaim<Runtime>,
);

/// Unchecked extrinsic type as expected by this runtime.
pub type UncheckedExtrinsic =
	generic::UncheckedExtrinsic<Address, RuntimeCall, Signature, TxExtension>;

/// The payload being signed in transactions.
pub type SignedPayload = generic::SignedPayload<RuntimeCall, TxExtension>;

/// Executive: handles dispatch to the various modules.
pub type Executive = frame_executive::Executive<
	Runtime,
	Block,
	frame_system::ChainContext<Runtime>,
	Runtime,
	AllPalletsWithSystem,
>;

// The pallets of the runtime, configured in `configs`. The indices are part of the call and
// event encoding: they never change.
#[frame_support::runtime]
mod runtime {
	#[runtime::runtime]
	#[runtime::derive(
		RuntimeCall,
		RuntimeEvent,
		RuntimeError,
		RuntimeOrigin,
		RuntimeFreezeReason,
		RuntimeHoldReason,
		RuntimeSlashReason,
		RuntimeLockId,
		RuntimeTask,
		RuntimeViewFunction
	)]
	pub struct Runtime;

	#[runtime::pallet_index(0)]
	pub type System = frame_system;

	#[runtime::pallet_index(1)]
	pub type Timestamp = pallet_timestamp;

	#[runtime::pallet_index(2)]
	pub type Aura = pallet_aura;

	#[runtime::pallet_index(3)]
	pub type Grandpa = pallet_grandpa;

	#[runtime::pallet_index(4)]
	pub type Balances = pallet_balances;

	#[runtime::pallet_index(5)]
	pub type TransactionPayment = pallet_transaction_payment;

	#[runtime::pallet_index(6)]
	pub type Sudo = pallet_sudo;

	#[runtime::pallet_index(7)]
	pub type SkipFeelessPayment = pallet_skip_feeless_payment;

	#[runtime::pallet_index(8)]
	pub type Identitee = pallet_identitee;

	// Declared before Session: session's genesis reads the validator set.
	#[runtime::pallet_index(9)]
	pub type Validators = pallet_validators;

	#[runtime::pallet_index(10)]
	pub type Session = pallet_session;

	#[runtime::pallet_index(11)]
	pub type Authorship = pallet_authorship;
}
