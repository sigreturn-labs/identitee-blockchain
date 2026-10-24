//! Consented sub-accounts: a parent account links other accounts to its identity.
//!
//! - The parent proposes ([`Pallet::do_add_sub`]): an account and a label (UTF-8, at most
//!   `MAX_SUB_LABEL_LEN` bytes). Nothing links until the sub accepts by its own transaction
//!   ([`Pallet::do_accept_sub`]), so nobody can claim an account as theirs. The parent withdraws a
//!   proposal or ends a link ([`Pallet::do_remove_sub`]); the sub refuses a proposal
//!   ([`Pallet::do_decline_sub`]) or leaves its parent ([`Pallet::do_quit_sub`]).
//! - A proposal does not tie its target down: it is a `SubProposals` entry of its own, and any
//!   number of parents can propose the same account. Only an accepted link (`SubOf`) is a
//!   membership, and an account has at most one.
//! - The sub needs no identity: a link is about the account. Clearing the identity of a sub
//!   leaves its link and the proposals it received alone. Clearing the identity of a parent drops
//!   everything it listed, links and proposals, and nothing else keeps them (the parent needs an
//!   identity to propose).
//! - At most `MAX_SUBS` per parent, accepted and pending together: `SubsOf` lists both.
//! - One level: an account is never both an accepted sub and the parent of accepted subs. It is
//!   enforced where a link is made, on accepted links only. Proposing needs a parent that is no
//!   accepted sub; accepting needs a sub with no parent and no accepted subs, and a parent that is
//!   no accepted sub. A proposal that has become impossible (its target found a parent, its
//!   proposer became a sub) stays, counted in its proposer's list, until the proposer withdraws it
//!   or the target declines it; accepting never goes through the other proposals of the target, so
//!   its cost does not depend on them.
//!
//! `SubOf` and `SubProposals` (per sub) and `SubsOf` (per parent) are two views of one relation
//! and always agree. A stored `SubsOf` list is never empty.
//!
//! The read functions are [`Pallet::subs_of`] (accepted subs of a parent),
//! [`Pallet::pending_subs_of`] (its proposals) and [`Pallet::parent_of`].

use crate::{
	types::SubLabel, validate, weights::WeightInfo, Config, Error, Event, Identities, Pallet,
	SubOf, SubProposals, SubsOf,
};
use alloc::vec::Vec;
use frame_support::{
	dispatch::{DispatchResult, DispatchResultWithPostInfo},
	ensure,
};

impl<T: Config> Pallet<T> {
	/// The subs of `parent` that accepted, in the order it proposed them, with their labels.
	pub fn subs_of(parent: &T::AccountId) -> Vec<(T::AccountId, Vec<u8>)> {
		Self::links_of(parent).0
	}

	/// The proposals of `parent` that nobody accepted yet, in the order it made them, with their
	/// labels.
	pub fn pending_subs_of(parent: &T::AccountId) -> Vec<(T::AccountId, Vec<u8>)> {
		Self::links_of(parent).1
	}

	/// The parent `sub` is a member of and the label it gave. A proposal is no membership.
	pub fn parent_of(sub: &T::AccountId) -> Option<(T::AccountId, Vec<u8>)> {
		SubOf::<T>::get(sub).map(|(parent, label)| (parent, label.into_inner()))
	}

	/// The list of `parent` split into accepted subs and pending proposals.
	///
	/// Every listed account is one or the other: that is what `SubsOf` is the list of. A broken
	/// invariant is a bug, not something to hide by skipping the entry.
	fn links_of(
		parent: &T::AccountId,
	) -> (Vec<(T::AccountId, Vec<u8>)>, Vec<(T::AccountId, Vec<u8>)>) {
		let (mut accepted, mut pending) = (Vec::new(), Vec::new());
		for sub in SubsOf::<T>::get(parent).unwrap_or_default() {
			if let Some(label) = Self::accepted_label(parent, &sub) {
				accepted.push((sub, label.into_inner()));
			} else if let Some(label) = SubProposals::<T>::get(&sub, parent) {
				pending.push((sub, label.into_inner()));
			} else {
				debug_assert!(false, "a listed sub has neither a link nor a proposal");
			}
		}
		(accepted, pending)
	}

	/// The label of the accepted link of `sub` to `parent`, if there is one.
	fn accepted_label(parent: &T::AccountId, sub: &T::AccountId) -> Option<SubLabel> {
		SubOf::<T>::get(sub)
			.filter(|(linked, _)| linked == parent)
			.map(|(_, label)| label)
	}

	/// `parent` proposes `sub`, with the label it will have. `parent` needs an identity, must not
	/// be an accepted sub itself, and needs room in its list. `sub` can be any other account,
	/// whatever links it has: what stops it is checked when it accepts.
	pub(crate) fn do_add_sub(
		parent: &T::AccountId,
		sub: T::AccountId,
		label: SubLabel,
	) -> DispatchResult {
		ensure!(Identities::<T>::contains_key(parent), Error::<T>::NoIdentity);
		ensure!(*parent != sub, Error::<T>::SubIsSelf);
		ensure!(validate::is_utf8(&label), Error::<T>::InvalidUtf8);
		ensure!(!SubOf::<T>::contains_key(parent), Error::<T>::ParentIsSub);
		// Last check, and the one that writes: nothing is stored if it fails.
		SubsOf::<T>::try_mutate(parent, |slot| {
			let subs = slot.get_or_insert_with(Default::default);
			ensure!(!subs.contains(&sub), Error::<T>::AlreadyProposed);
			subs.try_push(sub.clone()).map_err(|_| Error::<T>::TooManySubs)
		})?;
		SubProposals::<T>::insert(&sub, parent, label);
		Self::deposit_event(Event::SubProposed { parent: parent.clone(), sub });
		Ok(())
	}

	/// `sub` accepts the proposal of `parent`: the proposal becomes the link of `sub`. `sub` must
	/// have no parent and no accepted subs, and `parent` must be no accepted sub. The other
	/// proposals made to `sub` are left alone.
	///
	/// Reports the weight it used: the search of the subs of `sub` for an accepted one is the
	/// only part that is not constant.
	pub(crate) fn do_accept_sub(
		sub: &T::AccountId,
		parent: T::AccountId,
	) -> DispatchResultWithPostInfo {
		let failed = |scan_reads: u32, error: Error<T>| {
			Self::failed(T::WeightInfo::accept_sub_actual(scan_reads), error)
		};
		let label = SubProposals::<T>::get(sub, &parent)
			.ok_or_else(|| failed(0, Error::<T>::NoSuchProposal))?;
		ensure!(!SubOf::<T>::contains_key(sub), failed(0, Error::<T>::AlreadyHasParent));
		ensure!(!SubOf::<T>::contains_key(&parent), failed(0, Error::<T>::ParentIsSub));
		let (has_subs, scan_reads) = Self::has_accepted_subs(sub);
		ensure!(!has_subs, failed(scan_reads, Error::<T>::SubIsParent));
		SubProposals::<T>::remove(sub, &parent);
		SubOf::<T>::insert(sub, (parent.clone(), label));
		Self::deposit_event(Event::SubAccepted { parent, sub: sub.clone() });
		Ok(Self::used(T::WeightInfo::accept_sub_actual(scan_reads)))
	}

	/// `parent` withdraws its proposal to `sub`, or ends its accepted link with it.
	pub(crate) fn do_remove_sub(parent: &T::AccountId, sub: T::AccountId) -> DispatchResult {
		if Self::accepted_label(parent, &sub).is_some() {
			SubOf::<T>::remove(&sub);
		} else {
			ensure!(SubProposals::<T>::contains_key(&sub, parent), Error::<T>::NotYourSub);
			SubProposals::<T>::remove(&sub, parent);
		}
		Self::unlist(parent, &sub);
		Self::deposit_event(Event::SubRemoved { parent: parent.clone(), sub });
		Ok(())
	}

	/// `sub` ends its accepted link with its parent. Proposals are declined with
	/// [`Pallet::do_decline_sub`].
	pub(crate) fn do_quit_sub(sub: &T::AccountId) -> DispatchResult {
		let (parent, _) = SubOf::<T>::take(sub).ok_or(Error::<T>::NoParent)?;
		Self::unlist(&parent, sub);
		Self::deposit_event(Event::SubLeft { parent, sub: sub.clone() });
		Ok(())
	}

	/// `sub` refuses the proposal of `parent`.
	pub(crate) fn do_decline_sub(sub: &T::AccountId, parent: T::AccountId) -> DispatchResult {
		ensure!(SubProposals::<T>::contains_key(sub, &parent), Error::<T>::NoSuchProposal);
		SubProposals::<T>::remove(sub, &parent);
		Self::unlist(&parent, sub);
		Self::deposit_event(Event::SubDeclined { parent, sub: sub.clone() });
		Ok(())
	}

	/// `parent` changes the label of `sub`, whether the link is accepted or still a proposal.
	pub(crate) fn do_rename_sub(
		parent: &T::AccountId,
		sub: T::AccountId,
		label: SubLabel,
	) -> DispatchResult {
		ensure!(validate::is_utf8(&label), Error::<T>::InvalidUtf8);
		if Self::accepted_label(parent, &sub).is_some() {
			SubOf::<T>::insert(&sub, (parent.clone(), label));
		} else {
			ensure!(SubProposals::<T>::contains_key(&sub, parent), Error::<T>::NotYourSub);
			SubProposals::<T>::insert(&sub, parent, label);
		}
		Self::deposit_event(Event::SubLabelSet { parent: parent.clone(), sub });
		Ok(())
	}

	/// Run when the identity of `parent` is cleared: everything it listed goes, accepted links
	/// and proposals alike. The number of entries dropped. What `parent` is to others (a sub of
	/// someone, the target of proposals) is not touched: a link is about the account, not its
	/// identity.
	pub(crate) fn drop_subs_on_identity_cleared(parent: &T::AccountId) -> u32 {
		let subs = SubsOf::<T>::take(parent).unwrap_or_default();
		for sub in subs.iter() {
			// A listed account that is not pending is an accepted sub.
			if SubProposals::<T>::take(sub, parent).is_none() {
				SubOf::<T>::remove(sub);
			}
			Self::deposit_event(Event::SubRemoved { parent: parent.clone(), sub: sub.clone() });
		}
		subs.len() as u32
	}

	/// Whether `parent` has an accepted sub, and how many links it looked at to find out: the
	/// subs it listed, up to the first accepted one. At most `MAX_SUBS`.
	fn has_accepted_subs(parent: &T::AccountId) -> (bool, u32) {
		let mut reads = 0u32;
		let found = SubsOf::<T>::get(parent).unwrap_or_default().iter().any(|sub| {
			reads = reads.saturating_add(1);
			Self::accepted_label(parent, sub).is_some()
		});
		(found, reads)
	}

	/// Take `sub` off the list of `parent`, and delete the list with its last entry.
	fn unlist(parent: &T::AccountId, sub: &T::AccountId) {
		SubsOf::<T>::mutate_exists(parent, |slot| {
			if let Some(subs) = slot {
				subs.retain(|listed| listed != sub);
				if subs.is_empty() {
					*slot = None;
				}
			}
		});
	}
}
