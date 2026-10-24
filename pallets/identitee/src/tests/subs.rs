use crate::{
	limits::{MAX_SUBS, MAX_SUB_LABEL_LEN},
	mock::*,
	types::SubLabel,
	Error, Event, Identities, SubOf, SubProposals, SubsOf,
};
use frame_support::{
	assert_noop, assert_ok,
	dispatch::CheckIfFeeless,
	traits::{GetCallIndex, UnfilteredDispatchable},
};
use sp_runtime::{DispatchError, DispatchResult};
use std::collections::{BTreeMap, BTreeSet};

const PARENT: u64 = 1;
const SUB: u64 = 2;
const OTHER: u64 = 3;
const THIRD: u64 = 4;

fn label(text: &str) -> SubLabel {
	SubLabel::try_from(text.as_bytes().to_vec()).unwrap()
}

/// Gives `who` an identity (a bio is enough).
fn identity(who: u64) {
	let bio = crate::types::Bio::try_from(b"hello".to_vec()).unwrap();
	assert_ok!(Identitee::set_bio(RuntimeOrigin::signed(who), bio));
}

fn propose(parent: u64, sub: u64, text: &str) -> DispatchResult {
	Identitee::add_sub(RuntimeOrigin::signed(parent), sub, label(text))
}

fn accept(sub: u64, parent: u64) -> DispatchResult {
	Identitee::accept_sub(RuntimeOrigin::signed(sub), parent)
		.map(|_| ())
		.map_err(|e| e.error)
}

fn remove(parent: u64, sub: u64) -> DispatchResult {
	Identitee::remove_sub(RuntimeOrigin::signed(parent), sub)
}

fn leave(sub: u64) -> DispatchResult {
	Identitee::quit_sub(RuntimeOrigin::signed(sub))
}

fn decline(sub: u64, parent: u64) -> DispatchResult {
	Identitee::decline_sub(RuntimeOrigin::signed(sub), parent)
}

fn relabel(parent: u64, sub: u64, text: &str) -> DispatchResult {
	Identitee::rename_sub(RuntimeOrigin::signed(parent), sub, label(text))
}

/// `parent` proposes `sub` and `sub` accepts: an accepted link.
fn link(parent: u64, sub: u64, text: &str) {
	assert_ok!(propose(parent, sub, text));
	assert_ok!(accept(sub, parent));
}

fn pending(parent: u64) -> Vec<u64> {
	Identitee::pending_subs_of(&parent).into_iter().map(|(sub, _)| sub).collect()
}

fn accepted(parent: u64) -> Vec<u64> {
	Identitee::subs_of(&parent).into_iter().map(|(sub, _)| sub).collect()
}

/// The three maps are views of one relation, and the tree has one level.
///
/// - `SubsOf[p]` contains `s` exactly when `SubOf[s]` names `p` (accepted) or `SubProposals[(s,
///   p)]` exists (pending), never both;
/// - a stored list is never empty, never longer than `MAX_SUBS`, has no duplicates, and its owner
///   has an identity;
/// - nobody is its own parent;
/// - nobody is both an accepted sub and the parent of accepted subs.
///
/// An account may be an accepted sub and hold pending proposals it made before, or be a parent
/// and be the target of proposals: only accepted links are held to one level.
fn assert_subs_consistent() {
	let lists: BTreeMap<u64, Vec<u64>> =
		SubsOf::<Test>::iter().map(|(parent, list)| (parent, list.to_vec())).collect();
	let links: BTreeMap<u64, u64> =
		SubOf::<Test>::iter().map(|(sub, (parent, _))| (sub, parent)).collect();
	let proposals: BTreeSet<(u64, u64)> =
		SubProposals::<Test>::iter().map(|(sub, parent, _)| (sub, parent)).collect();

	for (parent, list) in &lists {
		assert!(!list.is_empty(), "empty list stored for parent {parent}");
		assert!(list.len() <= MAX_SUBS as usize, "parent {parent} lists {} subs", list.len());
		let unique: BTreeSet<_> = list.iter().collect();
		assert_eq!(unique.len(), list.len(), "duplicates in the list of {parent}: {list:?}");
		assert!(Identities::<Test>::contains_key(parent), "parent {parent} has no identity");
		for sub in list {
			let is_link = links.get(sub) == Some(parent);
			let is_proposal = proposals.contains(&(*sub, *parent));
			assert!(
				is_link ^ is_proposal,
				"{sub} under {parent}: link {is_link}, proposal {is_proposal}"
			);
		}
	}
	for (sub, parent) in &links {
		assert_ne!(sub, parent, "{sub} is its own parent");
		assert!(lists.get(parent).is_some_and(|l| l.contains(sub)), "{sub} not listed by {parent}");
	}
	for (sub, parent) in &proposals {
		assert_ne!(sub, parent, "{sub} is proposed to itself");
		assert!(lists.get(parent).is_some_and(|l| l.contains(sub)), "{sub} not listed by {parent}");
	}
	let listed: usize = lists.values().map(Vec::len).sum();
	assert_eq!(listed, links.len() + proposals.len());
	// One level, on accepted links.
	let parents: BTreeSet<_> = links.values().collect();
	for sub in links.keys() {
		assert!(!parents.contains(sub), "{sub} is an accepted sub and has accepted subs");
	}
}

// --- Consent ---

#[test]
fn sub_link_needs_acceptance() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		assert_ok!(propose(PARENT, SUB, "laptop"));
		System::assert_last_event(Event::SubProposed { parent: PARENT, sub: SUB }.into());
		assert_subs_consistent();

		// Proposed only: the sub is not yet "a member of" the parent, and the parent's subs are
		// the accepted ones.
		assert_eq!(Identitee::parent_of(&SUB), None);
		assert!(Identitee::subs_of(&PARENT).is_empty());
		assert_eq!(Identitee::pending_subs_of(&PARENT), vec![(SUB, b"laptop".to_vec())]);

		assert_ok!(accept(SUB, PARENT));
		System::assert_last_event(Event::SubAccepted { parent: PARENT, sub: SUB }.into());
		assert_eq!(Identitee::parent_of(&SUB), Some((PARENT, b"laptop".to_vec())));
		assert_eq!(Identitee::subs_of(&PARENT), vec![(SUB, b"laptop".to_vec())]);
		assert!(Identitee::pending_subs_of(&PARENT).is_empty());
		assert_subs_consistent();
	});
}

#[test]
fn the_sub_needs_no_identity() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		assert!(!Identities::<Test>::contains_key(SUB));
		link(PARENT, SUB, "cold wallet");
		assert_eq!(Identitee::parent_of(&SUB), Some((PARENT, b"cold wallet".to_vec())));
		// Linking did not create an identity for it.
		assert!(!Identities::<Test>::contains_key(SUB));
		assert_subs_consistent();
	});
}

#[test]
fn the_parent_needs_an_identity() {
	new_test_ext().execute_with(|| {
		assert_noop!(propose(PARENT, SUB, "x"), Error::<Test>::NoIdentity);
		assert!(SubProposals::<Test>::get(SUB, PARENT).is_none());
		assert!(SubsOf::<Test>::get(PARENT).is_none());
	});
}

#[test]
fn cannot_accept_unproposed() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		identity(OTHER);
		// Nothing proposed at all.
		assert_noop!(accept(SUB, PARENT), Error::<Test>::NoSuchProposal);

		assert_ok!(propose(PARENT, SUB, "laptop"));
		// Proposed by someone else, not by this parent.
		assert_noop!(accept(SUB, OTHER), Error::<Test>::NoSuchProposal);
		// The parent cannot accept on behalf of the sub, nor can a stranger.
		assert_noop!(accept(PARENT, PARENT), Error::<Test>::NoSuchProposal);
		assert_noop!(accept(THIRD, PARENT), Error::<Test>::NoSuchProposal);
		assert_eq!(Identitee::parent_of(&SUB), None);

		// The proposal becomes the link: there is nothing left to accept.
		assert_ok!(accept(SUB, PARENT));
		assert_noop!(accept(SUB, PARENT), Error::<Test>::NoSuchProposal);
		assert_subs_consistent();
	});
}

#[test]
fn sub_has_single_parent() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		identity(OTHER);
		assert_ok!(propose(PARENT, SUB, "laptop"));
		assert_ok!(propose(OTHER, SUB, "phone"));

		assert_ok!(accept(SUB, PARENT));
		// A second parent is refused when the sub accepts it, not before: an account with a
		// parent can still be proposed.
		identity(THIRD);
		assert_ok!(propose(THIRD, SUB, "tablet"));
		assert_noop!(accept(SUB, THIRD), Error::<Test>::AlreadyHasParent);
		assert_ok!(decline(SUB, THIRD));
		assert_noop!(accept(SUB, OTHER), Error::<Test>::AlreadyHasParent);
		assert_eq!(Identitee::parent_of(&SUB), Some((PARENT, b"laptop".to_vec())));
		// Its proposal stays, as the other proposals of the sub do.
		assert_eq!(Identitee::pending_subs_of(&OTHER), vec![(SUB, b"phone".to_vec())]);
		assert_subs_consistent();

		// Once the first parent is left, the other proposal can be accepted.
		assert_ok!(leave(SUB));
		assert_ok!(accept(SUB, OTHER));
		assert_eq!(Identitee::parent_of(&SUB), Some((OTHER, b"phone".to_vec())));
		assert_subs_consistent();
	});
}

#[test]
fn several_parents_can_propose_the_same_account() {
	new_test_ext().execute_with(|| {
		for who in [PARENT, OTHER, THIRD] {
			identity(who);
			assert_ok!(propose(who, SUB, "shared"));
			assert_subs_consistent();
		}
		for who in [PARENT, OTHER, THIRD] {
			assert_eq!(pending(who), vec![SUB]);
		}
		assert_eq!(Identitee::parent_of(&SUB), None);
	});
}

#[test]
fn a_proposal_cannot_be_repeated() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		assert_ok!(propose(PARENT, SUB, "laptop"));
		assert_noop!(propose(PARENT, SUB, "again"), Error::<Test>::AlreadyProposed);
		assert_ok!(accept(SUB, PARENT));
		// Already its sub: the label is changed with `rename_sub`.
		assert_noop!(propose(PARENT, SUB, "again"), Error::<Test>::AlreadyProposed);
		assert_eq!(Identitee::subs_of(&PARENT), vec![(SUB, b"laptop".to_vec())]);
		assert_subs_consistent();

		assert_ok!(leave(SUB));
		assert_ok!(propose(PARENT, SUB, "again"));
	});
}

#[test]
fn nobody_is_its_own_sub() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		assert_noop!(propose(PARENT, PARENT, "me"), Error::<Test>::SubIsSelf);
	});
}

// --- A proposal does not park its target ---

#[test]
fn a_proposal_does_not_park_its_target() {
	new_test_ext().execute_with(|| {
		let attacker = OTHER;
		for who in [PARENT, attacker, SUB] {
			identity(who);
		}
		// Anyone with an identity proposes the account...
		assert_ok!(propose(attacker, SUB, "spam"));
		// ...and its real parent can still propose it, and it accepts the real one.
		assert_ok!(propose(PARENT, SUB, "laptop"));
		assert_ok!(accept(SUB, PARENT));
		assert_eq!(Identitee::parent_of(&SUB), Some((PARENT, b"laptop".to_vec())));
		assert_subs_consistent();

		// The attacker's proposal is refused when accepted, stays in the attacker's list, and
		// the target can drop it.
		assert_noop!(accept(SUB, attacker), Error::<Test>::AlreadyHasParent);
		assert_eq!(pending(attacker), vec![SUB]);
		assert_ok!(decline(SUB, attacker));
		System::assert_last_event(Event::SubDeclined { parent: attacker, sub: SUB }.into());
		assert!(pending(attacker).is_empty());
		assert!(SubsOf::<Test>::get(attacker).is_none());
		assert_subs_consistent();
	});
}

#[test]
fn a_target_of_proposals_can_still_have_subs_of_its_own() {
	new_test_ext().execute_with(|| {
		for who in [PARENT, SUB, OTHER] {
			identity(who);
		}
		// SUB receives a proposal, and makes one of its own.
		assert_ok!(propose(PARENT, SUB, "laptop"));
		assert_ok!(propose(SUB, OTHER, "phone"));
		assert_ok!(accept(OTHER, SUB));
		assert_subs_consistent();

		// SUB has an accepted sub now: it cannot become one, which is checked when it accepts.
		assert_noop!(accept(SUB, PARENT), Error::<Test>::SubIsParent);
		assert_eq!(pending(PARENT), vec![SUB]);
		assert_subs_consistent();

		// Once its last accepted sub is gone, it can accept.
		assert_ok!(remove(SUB, OTHER));
		assert_ok!(accept(SUB, PARENT));
		assert_subs_consistent();
	});
}

#[test]
fn the_tree_has_one_level() {
	new_test_ext().execute_with(|| {
		for who in [PARENT, SUB, OTHER, THIRD] {
			identity(who);
		}
		// SUB proposes THIRD while it is free, then becomes a sub.
		assert_ok!(propose(SUB, THIRD, "phone"));
		link(PARENT, SUB, "laptop");
		// An accepted sub cannot propose: refused at once...
		assert_noop!(propose(SUB, OTHER, "x"), Error::<Test>::ParentIsSub);
		// ...and the proposal it made before is refused when THIRD accepts.
		assert_noop!(accept(THIRD, SUB), Error::<Test>::ParentIsSub);
		assert_subs_consistent();

		// A parent with an accepted sub cannot be a sub, though it can be proposed.
		assert_ok!(propose(OTHER, PARENT, "p"));
		assert_noop!(accept(PARENT, OTHER), Error::<Test>::SubIsParent);
		assert_subs_consistent();

		// Pending proposals made by the parent do not count, only accepted subs do.
		assert_ok!(remove(PARENT, SUB));
		assert_ok!(propose(PARENT, THIRD, "pending only"));
		assert_ok!(accept(PARENT, OTHER));
		assert_eq!(Identitee::parent_of(&PARENT), Some((OTHER, b"p".to_vec())));
		assert_subs_consistent();
		// Now that it is a sub, its pending proposal cannot be accepted.
		assert_noop!(accept(THIRD, PARENT), Error::<Test>::ParentIsSub);
		assert_noop!(propose(PARENT, SUB, "x"), Error::<Test>::ParentIsSub);
		assert_subs_consistent();
	});
}

// --- Breaking links ---

#[test]
fn either_side_can_break() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		identity(OTHER);

		// Pending: the parent withdraws.
		assert_ok!(propose(PARENT, SUB, "laptop"));
		assert_ok!(remove(PARENT, SUB));
		System::assert_last_event(Event::SubRemoved { parent: PARENT, sub: SUB }.into());
		assert!(SubProposals::<Test>::get(SUB, PARENT).is_none());
		assert_subs_consistent();

		// Pending: the sub declines.
		assert_ok!(propose(PARENT, SUB, "laptop"));
		assert_ok!(decline(SUB, PARENT));
		System::assert_last_event(Event::SubDeclined { parent: PARENT, sub: SUB }.into());
		assert!(SubProposals::<Test>::get(SUB, PARENT).is_none());
		assert_subs_consistent();

		// Accepted: the parent removes.
		link(PARENT, SUB, "laptop");
		assert_ok!(remove(PARENT, SUB));
		System::assert_last_event(Event::SubRemoved { parent: PARENT, sub: SUB }.into());
		assert_eq!(Identitee::parent_of(&SUB), None);
		assert_subs_consistent();

		// Accepted: the sub leaves.
		link(PARENT, SUB, "laptop");
		assert_ok!(leave(SUB));
		System::assert_last_event(Event::SubLeft { parent: PARENT, sub: SUB }.into());
		assert_eq!(Identitee::parent_of(&SUB), None);
		assert!(Identitee::subs_of(&PARENT).is_empty());
		// The parent's list is deleted with its last entry, not kept empty.
		assert!(SubsOf::<Test>::get(PARENT).is_none());
		assert_subs_consistent();
	});
}

#[test]
fn leaving_and_declining_are_not_interchangeable() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		identity(OTHER);
		assert_ok!(propose(PARENT, SUB, "laptop"));
		assert_ok!(propose(OTHER, SUB, "phone"));

		// A proposal is not a parent to leave.
		assert_noop!(leave(SUB), Error::<Test>::NoParent);
		assert_eq!(pending(PARENT), vec![SUB]);

		assert_ok!(accept(SUB, PARENT));
		// An accepted link is not a proposal to decline.
		assert_noop!(decline(SUB, PARENT), Error::<Test>::NoSuchProposal);
		assert_noop!(decline(THIRD, PARENT), Error::<Test>::NoSuchProposal);

		// Leaving leaves the other proposals alone.
		assert_ok!(leave(SUB));
		assert_eq!(pending(OTHER), vec![SUB]);
		assert_subs_consistent();
	});
}

#[test]
fn only_the_parent_removes_and_only_a_sub_leaves() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		identity(OTHER);
		link(PARENT, SUB, "laptop");
		assert_ok!(propose(PARENT, THIRD, "pending"));

		for target in [SUB, THIRD] {
			assert_noop!(remove(OTHER, target), Error::<Test>::NotYourSub);
			assert_noop!(remove(target, target), Error::<Test>::NotYourSub);
		}
		assert_noop!(remove(PARENT, 99), Error::<Test>::NotYourSub);
		assert_noop!(leave(PARENT), Error::<Test>::NoParent);
		assert_noop!(leave(OTHER), Error::<Test>::NoParent);
		assert_eq!(Identitee::parent_of(&SUB), Some((PARENT, b"laptop".to_vec())));
		assert_eq!(pending(PARENT), vec![THIRD]);
		assert_subs_consistent();
	});
}

#[test]
fn breaking_one_link_leaves_the_other_subs() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		link(PARENT, 10, "a");
		assert_ok!(propose(PARENT, 11, "b"));
		link(PARENT, 12, "c");
		assert_eq!(SubsOf::<Test>::get(PARENT).unwrap().to_vec(), vec![10, 11, 12]);
		assert_eq!(accepted(PARENT), vec![10, 12]);
		assert_eq!(pending(PARENT), vec![11]);

		assert_ok!(remove(PARENT, 11));
		assert_eq!(SubsOf::<Test>::get(PARENT).unwrap().to_vec(), vec![10, 12]);
		assert_ok!(leave(10));
		assert_eq!(Identitee::subs_of(&PARENT), vec![(12, b"c".to_vec())]);
		assert_subs_consistent();
	});
}

#[test]
fn a_link_can_be_made_again_after_it_was_broken() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		link(PARENT, SUB, "first");
		assert_ok!(leave(SUB));
		// A fresh proposal: pending again, with the new label.
		assert_ok!(propose(PARENT, SUB, "second"));
		assert_eq!(Identitee::parent_of(&SUB), None);
		assert_ok!(accept(SUB, PARENT));
		assert_eq!(Identitee::parent_of(&SUB), Some((PARENT, b"second".to_vec())));
		assert_subs_consistent();
	});
}

// --- The limit ---

#[test]
fn max_100_subs() {
	new_test_ext().execute_with(|| {
		assert_eq!(MAX_SUBS, 100);
		identity(PARENT);
		for i in 0..u64::from(MAX_SUBS) {
			let sub = 1000 + i;
			assert_ok!(propose(PARENT, sub, "s"));
			// Pending and accepted links count alike.
			if i % 2 == 0 {
				assert_ok!(accept(sub, PARENT));
			}
		}
		assert_eq!(accepted(PARENT).len(), 50);
		assert_eq!(pending(PARENT).len(), 50);
		assert_noop!(propose(PARENT, 5000, "one too many"), Error::<Test>::TooManySubs);
		assert!(SubProposals::<Test>::get(5000, PARENT).is_none());
		assert_eq!(SubsOf::<Test>::get(PARENT).unwrap().len(), MAX_SUBS as usize);
		assert_subs_consistent();

		// A slot freed by the parent, by an accepted sub leaving, or by a declined proposal can
		// be used.
		assert_ok!(remove(PARENT, 1001));
		assert_ok!(propose(PARENT, 5000, "fits now"));
		assert_noop!(propose(PARENT, 5001, "full again"), Error::<Test>::TooManySubs);
		assert_ok!(leave(1000));
		assert_ok!(propose(PARENT, 5001, "fits"));
		assert_noop!(propose(PARENT, 5002, "full again"), Error::<Test>::TooManySubs);
		assert_ok!(decline(5001, PARENT));
		assert_ok!(propose(PARENT, 5002, "fits"));
		assert_subs_consistent();
	});
}

// --- Labels ---

#[test]
fn labels_are_utf8_and_bounded() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		// The type stops the label at the maximum length.
		assert_eq!(MAX_SUB_LABEL_LEN, 64);
		assert!(SubLabel::try_from(vec![b'a'; 65]).is_err());
		let longest = SubLabel::try_from(vec![b'a'; 64]).unwrap();
		assert_ok!(Identitee::add_sub(RuntimeOrigin::signed(PARENT), SUB, longest));

		// Not UTF-8: refused, and nothing is stored.
		let bad = SubLabel::try_from(vec![0xff, 0xfe]).unwrap();
		assert_noop!(
			Identitee::add_sub(RuntimeOrigin::signed(PARENT), OTHER, bad.clone()),
			Error::<Test>::InvalidUtf8
		);
		assert!(SubProposals::<Test>::get(OTHER, PARENT).is_none());
		assert_noop!(
			Identitee::rename_sub(RuntimeOrigin::signed(PARENT), SUB, bad),
			Error::<Test>::InvalidUtf8
		);
		assert_eq!(Identitee::pending_subs_of(&PARENT)[0].1, vec![b'a'; 64]);

		// Multi-byte text counts in bytes: 32 times a 2-byte character is exactly 64.
		let accents = "é".repeat(32);
		assert_ok!(relabel(PARENT, SUB, &accents));
		assert_eq!(Identitee::pending_subs_of(&PARENT)[0].1, accents.as_bytes().to_vec());
	});
}

#[test]
fn the_parent_relabels_pending_and_accepted_subs() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		identity(OTHER);
		assert_ok!(propose(PARENT, SUB, "old"));
		assert_ok!(relabel(PARENT, SUB, "pending"));
		System::assert_last_event(Event::SubLabelSet { parent: PARENT, sub: SUB }.into());
		assert_eq!(Identitee::pending_subs_of(&PARENT), vec![(SUB, b"pending".to_vec())]);
		assert_subs_consistent();

		// The label of the proposal is the label of the link.
		assert_ok!(accept(SUB, PARENT));
		assert_eq!(Identitee::parent_of(&SUB), Some((PARENT, b"pending".to_vec())));
		assert_ok!(relabel(PARENT, SUB, "accepted"));
		// Relabelling keeps the consent.
		assert_eq!(Identitee::parent_of(&SUB), Some((PARENT, b"accepted".to_vec())));
		assert_eq!(Identitee::subs_of(&PARENT), vec![(SUB, b"accepted".to_vec())]);
		assert_subs_consistent();

		// Not the sub itself, not another parent, not an unlinked account.
		assert_noop!(relabel(SUB, SUB, "mine"), Error::<Test>::NotYourSub);
		assert_noop!(relabel(OTHER, SUB, "theirs"), Error::<Test>::NotYourSub);
		assert_noop!(relabel(PARENT, THIRD, "none"), Error::<Test>::NotYourSub);
		// A proposal from another parent is not the caller's to relabel.
		assert_ok!(propose(OTHER, SUB, "other"));
		assert_ok!(relabel(OTHER, SUB, "renamed"));
		assert_eq!(Identitee::parent_of(&SUB), Some((PARENT, b"accepted".to_vec())));
		assert_eq!(Identitee::pending_subs_of(&OTHER), vec![(SUB, b"renamed".to_vec())]);
		assert_subs_consistent();
	});
}

// --- Clearing identities ---

#[test]
fn parent_clear_identity_drops_subs() {
	for force in [false, true] {
		new_test_ext().execute_with(|| {
			identity(PARENT);
			identity(OTHER);
			link(PARENT, 10, "a");
			assert_ok!(propose(PARENT, 11, "b"));
			link(PARENT, 12, "c");
			// Another parent's link, to the very account PARENT only proposed, and its other
			// link stay.
			link(OTHER, 11, "z");
			link(OTHER, 20, "y");
			assert_subs_consistent();

			if force {
				assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), PARENT));
				System::assert_last_event(Event::IdentityPurged { who: PARENT }.into());
			} else {
				assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(PARENT)));
				System::assert_last_event(Event::IdentityCleared { who: PARENT }.into());
			}

			// Accepted links and pending proposals alike are gone, each with an event.
			for sub in [10, 12] {
				assert!(SubOf::<Test>::get(sub).is_none(), "sub {sub} is still linked");
			}
			assert!(SubProposals::<Test>::get(11, PARENT).is_none());
			for sub in [10, 11, 12] {
				System::assert_has_event(Event::SubRemoved { parent: PARENT, sub }.into());
			}
			assert!(SubsOf::<Test>::get(PARENT).is_none());
			assert!(Identitee::subs_of(&PARENT).is_empty());
			assert!(Identitee::pending_subs_of(&PARENT).is_empty());
			// The other parent is untouched.
			assert_eq!(Identitee::parent_of(&11), Some((OTHER, b"z".to_vec())));
			assert_eq!(Identitee::parent_of(&20), Some((OTHER, b"y".to_vec())));
			assert_eq!(Identitee::subs_of(&OTHER), vec![(11, b"z".to_vec()), (20, b"y".to_vec())]);
			assert!(Identitee::pending_subs_of(&OTHER).is_empty());
			assert_subs_consistent();

			// Freed accounts can be taken by someone else.
			assert_ok!(propose(OTHER, 10, "again"));
			assert_subs_consistent();
		});
	}
}

#[test]
fn clearing_the_identity_of_a_parent_without_subs_touches_no_link() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		identity(OTHER);
		link(OTHER, SUB, "x");
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(PARENT)));
		assert!(!System::events().iter().any(|record| matches!(
			record.event,
			RuntimeEvent::Identitee(Event::SubRemoved { .. })
		)));
		assert_eq!(Identitee::parent_of(&SUB), Some((OTHER, b"x".to_vec())));
		assert_subs_consistent();
	});
}

#[test]
fn a_sub_clearing_its_own_identity_keeps_its_link_and_its_proposals() {
	for force in [false, true] {
		new_test_ext().execute_with(|| {
			for who in [PARENT, SUB, OTHER, THIRD] {
				identity(who);
			}
			// SUB is an accepted sub and has a proposal waiting from another parent; THIRD is
			// free and has one waiting.
			link(PARENT, SUB, "laptop");
			assert_ok!(propose(OTHER, SUB, "phone"));
			assert_ok!(propose(PARENT, THIRD, "tablet"));

			for who in [SUB, THIRD] {
				if force {
					assert_ok!(Identitee::kill_identity(RuntimeOrigin::root(), who));
				} else {
					assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(who)));
				}
				assert!(!Identities::<Test>::contains_key(who));
			}
			// The links are about the accounts, not about their identities.
			assert_eq!(Identitee::parent_of(&SUB), Some((PARENT, b"laptop".to_vec())));
			assert_eq!(Identitee::pending_subs_of(&OTHER), vec![(SUB, b"phone".to_vec())]);
			assert_eq!(Identitee::pending_subs_of(&PARENT), vec![(THIRD, b"tablet".to_vec())]);
			assert_noop!(accept(SUB, OTHER), Error::<Test>::AlreadyHasParent);
			assert_ok!(accept(THIRD, PARENT));
			assert_subs_consistent();
		});
	}
}

#[test]
fn a_cleared_account_loses_what_it_listed_but_not_what_it_is_to_others() {
	new_test_ext().execute_with(|| {
		for who in [PARENT, SUB, OTHER] {
			identity(who);
		}
		// OTHER lists a sub and a proposal, and is itself the target of a proposal.
		link(OTHER, SUB, "laptop");
		assert_ok!(propose(OTHER, THIRD, "tablet"));
		assert_ok!(propose(PARENT, OTHER, "boss"));

		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(OTHER)));
		assert_eq!(Identitee::parent_of(&SUB), None);
		assert!(SubsOf::<Test>::get(OTHER).is_none());
		assert!(SubProposals::<Test>::get(THIRD, OTHER).is_none());
		assert_eq!(Identitee::pending_subs_of(&PARENT), vec![(OTHER, b"boss".to_vec())]);
		assert_subs_consistent();
	});
}

#[test]
fn a_parent_that_cleared_cannot_propose_until_it_has_an_identity_again() {
	new_test_ext().execute_with(|| {
		identity(PARENT);
		link(PARENT, SUB, "laptop");
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(PARENT)));
		assert_noop!(propose(PARENT, SUB, "laptop"), Error::<Test>::NoIdentity);
		identity(PARENT);
		assert_ok!(propose(PARENT, SUB, "laptop"));
		// The old consent did not survive: pending again.
		assert_eq!(Identitee::parent_of(&SUB), None);
		assert_subs_consistent();
	});
}

// --- Calls ---

fn sub_calls() -> [crate::Call<Test>; 6] {
	[
		crate::Call::add_sub { sub: SUB, label: label("x") },
		crate::Call::accept_sub { parent: PARENT },
		crate::Call::remove_sub { sub: SUB },
		crate::Call::quit_sub {},
		crate::Call::rename_sub { sub: SUB, label: label("x") },
		crate::Call::decline_sub { parent: PARENT },
	]
}

#[test]
fn sub_calls_are_user_calls() {
	new_test_ext().execute_with(|| {
		for call in sub_calls() {
			// Any signed account within its quota, never Root or an unsigned origin...
			assert!(RuntimeCall::Identitee(call.clone()).is_feeless(&RuntimeOrigin::signed(PARENT)));
			assert!(!RuntimeCall::Identitee(call.clone()).is_feeless(&RuntimeOrigin::root()));
			assert!(!RuntimeCall::Identitee(call.clone()).is_feeless(&RuntimeOrigin::none()));
			// ...and each one consumes quota.
			assert!(call.counts_against_quota(), "{call:?}");
		}
	});
}

#[test]
fn sub_calls_need_a_signed_origin() {
	new_test_ext().execute_with(|| {
		for origin in [RuntimeOrigin::root(), RuntimeOrigin::none()] {
			for call in sub_calls() {
				assert_eq!(
					call.clone().dispatch_bypass_filter(origin.clone()).map_err(|e| e.error),
					Err(DispatchError::BadOrigin),
					"{call:?}"
				);
			}
		}
	});
}

#[test]
fn call_indices_are_pinned() {
	let indices: Vec<u8> = sub_calls().iter().map(|call| call.get_call_index()).collect();
	assert_eq!(indices, vec![50, 51, 52, 53, 54, 55]);
}

#[test]
fn sub_calls_declare_a_weight() {
	let declared = |call: crate::Call<Test>| {
		use frame_support::dispatch::GetDispatchInfo;
		call.get_dispatch_info().call_weight
	};
	for call in sub_calls() {
		let weight = declared(call.clone());
		assert!(weight.ref_time() > 0 && weight.proof_size() > 0, "{call:?}: {weight:?}");
	}
}

#[test]
fn subs_stay_consistent_through_a_mixed_sequence() {
	new_test_ext().execute_with(|| {
		for who in [PARENT, OTHER, THIRD] {
			identity(who);
			assert_subs_consistent();
		}

		assert_ok!(propose(PARENT, 10, "a"));
		assert_subs_consistent();
		assert_ok!(propose(PARENT, 11, "b"));
		assert_subs_consistent();
		assert_ok!(propose(OTHER, 12, "c"));
		assert_subs_consistent();
		// Another parent proposes the same account.
		assert_ok!(propose(OTHER, 10, "a2"));
		assert_subs_consistent();

		assert_ok!(accept(10, PARENT));
		assert_subs_consistent();
		assert_ok!(accept(12, OTHER));
		assert_subs_consistent();

		// Refused moves leave everything as it was.
		assert_noop!(accept(10, OTHER), Error::<Test>::AlreadyHasParent);
		assert_subs_consistent();
		assert_noop!(propose(10, 13, "x"), Error::<Test>::NoIdentity);
		assert_subs_consistent();
		assert_noop!(propose(PARENT, 11, "x"), Error::<Test>::AlreadyProposed);
		assert_subs_consistent();
		assert_noop!(accept(11, OTHER), Error::<Test>::NoSuchProposal);
		assert_subs_consistent();

		assert_ok!(relabel(PARENT, 11, "bee"));
		assert_subs_consistent();
		assert_ok!(relabel(PARENT, 10, "ay"));
		assert_subs_consistent();
		assert_ok!(decline(11, PARENT));
		assert_subs_consistent();
		assert_ok!(decline(10, OTHER));
		assert_subs_consistent();
		assert_ok!(propose(OTHER, 11, "b2"));
		assert_subs_consistent();
		assert_ok!(leave(10));
		assert_subs_consistent();
		assert_ok!(accept(11, OTHER));
		assert_subs_consistent();
		assert_noop!(remove(PARENT, 99), Error::<Test>::NotYourSub);
		assert_subs_consistent();

		// A parent with no accepted sub left can be a sub itself.
		assert_ok!(propose(THIRD, PARENT, "p"));
		assert_subs_consistent();
		assert_ok!(accept(PARENT, THIRD));
		assert_subs_consistent();
		assert_eq!(Identitee::parent_of(&PARENT), Some((THIRD, b"p".to_vec())));

		// Clearing a parent drops its list; being a sub of someone is not affected.
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(OTHER)));
		assert_subs_consistent();
		assert_ok!(Identitee::clear_identity(RuntimeOrigin::signed(THIRD)));
		assert_subs_consistent();
		assert!(SubOf::<Test>::iter().next().is_none());
		assert!(SubProposals::<Test>::iter().next().is_none());
		assert!(SubsOf::<Test>::iter().next().is_none());
	});
}
