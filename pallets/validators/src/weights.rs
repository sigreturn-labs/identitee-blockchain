//! Weights of the validators pallet.
//!
//! Hand-written, without benchmarks: a fixed computation cost plus the database accesses of
//! each call, with a proof size covering the validator list and the session keys it touches.

use core::marker::PhantomData;
use frame_support::{traits::Get, weights::Weight};

/// Weight functions of the validators pallet.
pub trait WeightInfo {
	/// `add_validator`, for keys made of `key_types` keys.
	fn add_validator(key_types: u32) -> Weight;
	/// `remove_validator`.
	fn remove_validator() -> Weight;
}

/// Computation cost of a call, apart from its database accesses.
const BASE: u64 = 20_000_000;
/// Proof size: the validator list (32 accounts) and a few session keys entries.
const PROOF: u64 = 4_096;

/// Weights for the runtime, from its database weights.
pub struct SubstrateWeight<T>(PhantomData<T>);

impl<T: frame_system::Config> WeightInfo for SubstrateWeight<T> {
	fn add_validator(key_types: u32) -> Weight {
		// Reads: the list, the old keys, one owner per key. Writes: the list, the change flag, the
		// keys, the external mark, and per key the new owner and the old one removed.
		let k = key_types as u64;
		Weight::from_parts(BASE, PROOF)
			.saturating_add(T::DbWeight::get().reads(2 + k))
			.saturating_add(T::DbWeight::get().writes(4 + 2 * k))
	}

	fn remove_validator() -> Weight {
		Weight::from_parts(BASE, PROOF)
			.saturating_add(T::DbWeight::get().reads(1))
			.saturating_add(T::DbWeight::get().writes(2))
	}
}

impl WeightInfo for () {
	fn add_validator(_: u32) -> Weight {
		Weight::zero()
	}

	fn remove_validator() -> Weight {
		Weight::zero()
	}
}
