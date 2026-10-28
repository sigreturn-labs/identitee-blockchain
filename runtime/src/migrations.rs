//! Runtime migrations.
//!
//! [`SessionFromConsensus`] brings sessions to a chain started without them (runtime 8 and
//! before), whose Aura and GRANDPA authorities were fixed at genesis. It makes the sudo account
//! the validator owning the current keys, so the upgrade changes no authority: the same node keeps
//! producing and finalizing blocks, and validators added later join through sessions.

use crate::{Runtime, SessionKeys};
use alloc::vec;
use frame_support::{traits::OnRuntimeUpgrade, weights::Weight};

/// Turns the single genesis authority into the first validator of the session set, owned by the
/// sudo account. Does nothing once the validator set exists, so it runs once.
pub struct SessionFromConsensus;

impl OnRuntimeUpgrade for SessionFromConsensus {
	fn on_runtime_upgrade() -> Weight {
		let db = <Runtime as frame_system::Config>::DbWeight::get();
		if !pallet_validators::Validators::<Runtime>::get().is_empty() {
			return db.reads(1);
		}
		let reads = 4;
		let Some(owner) = pallet_sudo::Key::<Runtime>::get() else {
			frame_support::print("SessionFromConsensus: no sudo key, nothing done");
			return db.reads(reads);
		};
		let aura = pallet_aura::Authorities::<Runtime>::get();
		let grandpa = pallet_grandpa::Authorities::<Runtime>::get();
		let ([aura], [(grandpa, _)]) = (aura.as_slice(), grandpa.as_slice()) else {
			frame_support::print("SessionFromConsensus: not a single authority, nothing done");
			return db.reads(reads);
		};
		let keys = SessionKeys { aura: aura.clone(), grandpa: grandpa.clone() };

		if pallet_validators::Pallet::<Runtime>::assign_keys(&owner, keys.clone()).is_err() {
			frame_support::print("SessionFromConsensus: keys already owned, nothing done");
			return db.reads(reads + 2);
		}
		pallet_validators::Validators::<Runtime>::put(frame_support::BoundedVec::truncate_from(
			vec![owner.clone()],
		));
		pallet_session::Validators::<Runtime>::put(vec![owner.clone()]);
		pallet_session::QueuedKeys::<Runtime>::put(vec![(owner, keys)]);
		// Reads: the guard, sudo, the two authority lists, the old keys and two owners. Writes:
		// two key owners, the keys, the external mark, and the three lists.
		db.reads_writes(reads + 3, 7)
	}
}
