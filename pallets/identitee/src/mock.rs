//! Test runtime for the identitee pallet.

use crate as pallet_identitee;
use frame_support::{derive_impl, traits::ConstU64, weights::constants::RocksDbWeight};
use frame_system::EnsureRoot;
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

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
	pub struct Test;

	#[runtime::pallet_index(0)]
	pub type System = frame_system;

	#[runtime::pallet_index(1)]
	pub type Identitee = pallet_identitee;
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
	// Database weights as in the runtime, so that the weights of the pallet are not all zero.
	type DbWeight = RocksDbWeight;
}

impl pallet_identitee::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type WeightInfo = crate::weights::SubstrateWeight<Test>;
	type AuthorityOrigin = EnsureRoot<u64>;
	type QuotaWindow = ConstU64<QUOTA_WINDOW_BLOCKS>;
	type NameQuarantine = ConstU64<NAME_QUARANTINE_BLOCKS>;
}

/// Quota window of the test runtime, in blocks: short, so tests can cross it.
pub const QUOTA_WINDOW_BLOCKS: u64 = 10;

/// Name quarantine of the test runtime, in blocks: short, so tests can cross it.
pub const NAME_QUARANTINE_BLOCKS: u64 = 20;

/// Externalities with empty genesis, at block 1 (so events are recorded).
pub fn new_test_ext() -> sp_io::TestExternalities {
	new_test_ext_with(Default::default())
}

/// Externalities with the given pallet genesis, at block 1 (so events are recorded).
pub fn new_test_ext_with(
	config: pallet_identitee::GenesisConfig<Test>,
) -> sp_io::TestExternalities {
	let mut storage = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();
	config.assimilate_storage(&mut storage).unwrap();
	let mut ext = sp_io::TestExternalities::new(storage);
	ext.execute_with(|| System::set_block_number(1));
	ext
}

/// A genesis authority named `name`, with its agents as `(account, capability bits)`.
pub fn authority(name: &str, agents: &[(u64, u8)]) -> crate::types::GenesisAuthority<u64> {
	crate::types::GenesisAuthority {
		name: name.into(),
		agents: agents
			.iter()
			.map(|&(account, caps)| crate::types::GenesisAgent { account, caps })
			.collect(),
	}
}
