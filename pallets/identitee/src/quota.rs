//! Limits on feeless calls: a quota per account and window, and a global cap per block.
//!
//! A user call is feeless while [`Pallet::feeless_allowed`] holds for its signer. Usage is
//! recorded by the runtime's transaction extension with [`Pallet::note_usage`], at prepare time
//! and outside dispatch, so a call whose dispatch fails (and rolls back its own storage changes)
//! still consumes quota. Checking never consumes: `feeless_if` is evaluated by the transaction
//! pool, which must not write.
//!
//! Which calls count is decided by [`Call::counts_against_quota`]; calls of authority agents
//! are feeless through their own rule, [`Pallet::agent_call_feeless`], and never touch these
//! counters.

use crate::{limits, pallet::*};
use frame_support::traits::Get;
use frame_system::pallet_prelude::*;
use sp_runtime::Saturating;

impl<T: Config> Pallet<T> {
	/// Whether `who` may make one more feeless user call now: its quota for the current window
	/// is not used up and the current block still accepts feeless calls. Read-only.
	pub fn feeless_allowed(who: &T::AccountId) -> bool {
		Self::quota_available(who) && Self::block_cap_available()
	}

	/// Whether `who` has quota left in its current window (a window that has ended counts as
	/// a fresh one). Read-only.
	pub fn quota_available(who: &T::AccountId) -> bool {
		match Usage::<T>::get(who) {
			Some((start, count)) if !Self::window_ended(start) => count < limits::QUOTA_PER_WINDOW,
			_ => true,
		}
	}

	/// Whether the current block still accepts feeless calls. Read-only.
	pub fn block_cap_available() -> bool {
		BlockFeelessOps::<T>::get() < limits::GLOBAL_FEELESS_PER_BLOCK
	}

	/// Record one feeless user call by `who`, in its window and in the block counter.
	///
	/// Called by the runtime's transaction extension once the transaction is accepted, never
	/// from dispatch. A window opens at the first use and lasts `QuotaWindow` blocks.
	pub fn note_usage(who: &T::AccountId) {
		let now = frame_system::Pallet::<T>::block_number();
		Usage::<T>::mutate(who, |usage| {
			*usage = match *usage {
				Some((start, count)) if !Self::window_ended(start) => {
					Some((start, count.saturating_add(1)))
				},
				_ => Some((now, 1)),
			};
		});
		BlockFeelessOps::<T>::mutate(|ops| *ops = ops.saturating_add(1));
	}

	/// Whether a user call from `origin` is feeless: signed, and within the limits.
	pub(crate) fn user_call_feeless(origin: &OriginFor<T>) -> bool {
		match ensure_signed(origin.clone()) {
			Ok(who) => Self::feeless_allowed(&who),
			Err(_) => false,
		}
	}

	/// Whether the window opened at `start` is over.
	fn window_ended(start: BlockNumberFor<T>) -> bool {
		frame_system::Pallet::<T>::block_number() >= start.saturating_add(T::QuotaWindow::get())
	}
}

impl<T: Config> Call<T> {
	/// Whether this call is a user call: feeless within [`Pallet::feeless_allowed`], and
	/// recorded with [`Pallet::note_usage`] when it is applied feelessly.
	///
	/// The match is exhaustive on purpose: every new call must be classified here.
	pub fn counts_against_quota(&self) -> bool {
		match self {
			Call::set_bio { .. }
			| Call::set_field { .. }
			| Call::clear_field { .. }
			| Call::set_identity { .. }
			| Call::set_identity_secret { .. }
			| Call::clear_identity_secret { .. }
			| Call::update_profile { .. }
			| Call::add_link { .. }
			| Call::update_link { .. }
			| Call::remove_link { .. }
			| Call::reorder_links { .. }
			| Call::set_avatar { .. }
			| Call::clear_avatar { .. }
			| Call::reveal_field { .. }
			| Call::clear_identity { .. }
			| Call::request_judgement { .. }
			| Call::cancel_request { .. }
			| Call::claim_username { .. }
			| Call::release_username { .. }
			| Call::add_sub { .. }
			| Call::accept_sub { .. }
			| Call::remove_sub { .. }
			| Call::quit_sub { .. }
			| Call::rename_sub { .. }
			| Call::decline_sub { .. }
			| Call::request_migration { .. }
			| Call::cancel_migration { .. } => true,
			Call::kill_identity { .. }
			| Call::add_authority { .. }
			| Call::set_agent { .. }
			| Call::remove_agent { .. }
			| Call::set_authority_active { .. }
			| Call::provide_judgement { .. }
			| Call::revoke_attestation { .. }
			| Call::reject_request { .. }
			| Call::grant_fact { .. }
			| Call::revoke_fact { .. }
			| Call::reserve_username { .. }
			| Call::unreserve_username { .. }
			| Call::set_username_for { .. }
			| Call::unbind_username { .. }
			| Call::fulfil_migration { .. }
			| Call::reject_migration { .. } => false,
			Call::__Ignore(..) => false,
		}
	}
}
