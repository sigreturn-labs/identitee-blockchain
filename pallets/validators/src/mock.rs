//! Test runtime for the validators pallet: session with one-block sessions and `UintAuthorityId`
//! keys.

use crate as pallet_validators;
use frame_support::{
	derive_impl,
	traits::{ConstU32, ConstU64},
	weights::constants::RocksDbWeight,
};
use frame_system::EnsureRoot;
use sp_runtime::{testing::UintAuthorityId, traits::ConvertInto, BuildStorage};

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
	pub type Balances = pallet_balances;

	#[runtime::pallet_index(2)]
	pub type Validators = pallet_validators;

	#[runtime::pallet_index(3)]
	pub type Session = pallet_session;
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
	type AccountData = pallet_balances::AccountData<u64>;
	type DbWeight = RocksDbWeight;
}

#[derive_impl(pallet_balances::config_preludes::TestDefaultConfig)]
impl pallet_balances::Config for Test {
	type AccountStore = System;
}

/// Every block ends a session, so tests rotate sessions block by block.
type EveryBlock = pallet_session::PeriodicSessions<ConstU64<1>, ConstU64<0>>;

impl pallet_session::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type ValidatorId = u64;
	type ValidatorIdOf = ConvertInto;
	type ShouldEndSession = EveryBlock;
	type NextSessionRotation = EveryBlock;
	type SessionManager = Validators;
	type SessionHandler = pallet_session::TestSessionHandler;
	type Keys = UintAuthorityId;
	type DisablingStrategy = ();
	type WeightInfo = ();
	type Currency = Balances;
	type KeyDeposit = ConstU64<0>;
}

impl pallet_validators::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type WeightInfo = crate::weights::SubstrateWeight<Test>;
	type ManagerOrigin = EnsureRoot<u64>;
	type MaxValidators = ConstU32<3>;
	type RewardCurrency = Balances;
	type BlockReward = ConstU64<BLOCK_REWARD>;
}

/// Block reward of the test runtime.
pub const BLOCK_REWARD: u64 = 10;

/// The genesis validator: account 1, with key 1.
pub const GENESIS_VALIDATOR: u64 = 1;

/// Externalities with account 1 as the only validator, at block 1 (so events are recorded).
pub fn new_test_ext() -> sp_io::TestExternalities {
	let mut storage = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();
	pallet_balances::GenesisConfig::<Test> {
		balances: vec![(GENESIS_VALIDATOR, 100)],
		..Default::default()
	}
	.assimilate_storage(&mut storage)
	.unwrap();
	pallet_validators::GenesisConfig::<Test> { validators: vec![GENESIS_VALIDATOR] }
		.assimilate_storage(&mut storage)
		.unwrap();
	pallet_session::GenesisConfig::<Test> {
		keys: vec![(GENESIS_VALIDATOR, GENESIS_VALIDATOR, UintAuthorityId(GENESIS_VALIDATOR))],
		..Default::default()
	}
	.assimilate_storage(&mut storage)
	.unwrap();
	let mut ext = sp_io::TestExternalities::new(storage);
	ext.execute_with(|| System::set_block_number(1));
	ext
}

/// Ends the current session: session starts the next one with the validators queued at the
/// previous change.
pub fn next_session() {
	pallet_session::Pallet::<Test>::rotate_session();
}
