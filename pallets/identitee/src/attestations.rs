//! Attestations: requests to an authority, field attestations and facts about the person.
//!
//! A field attestation is stored per (account, field, authority) and records the commitment of
//! the value the authority checked. It is valid while it is not revoked, not expired, and the
//! field still has that commitment ([`Pallet::attestation_is_valid`]): changing a field
//! invalidates that one attestation and nothing else (it stays stored, and becomes valid again
//! if the very same value is set back). Removing a field or a link deletes its attestations, so
//! an identity has at most one per present field and authority
//! ([`crate::limits::MAX_ATTESTATIONS_PER_IDENTITY`]).
//!
//! The commitment of a field is [`commitment`] of its value: a tagged hash of a public value,
//! or the private commitment as is. The commitment of a link ([`FieldKey::Link`]) is
//! [`link_commitment`] of its title and url, so changing either invalidates it. The three kinds
//! of commitments are domain-separated (see [`crate::types::PUBLIC_COMMITMENT_TAG`]).
//!
//! Clearing an identity deletes its attestations and requests, but not the facts about the
//! person: a person found fraudulent cannot erase the finding by clearing and recreating the
//! identity. Facts go only with a revocation by their authority or a purge by
//! `kill_identity`.
//!
//! One attestation per (account, field, authority) and one fact per (account, kind, authority):
//! attesting or granting again overwrites, and clears a revocation.
//!
//! Requests are optional: an agent may attest or grant without one, and doing so consumes the
//! matching request of its authority if there is one. `PendingCount` is the exact number of
//! `PendingRequests` entries of an account, capped at [`MAX_PENDING_REQUESTS`].

use crate::{
	limits::{MAX_ATTESTATIONS_PER_IDENTITY, MAX_AUTHORITIES, MAX_PENDING_REQUESTS},
	types::{
		commitment, link_commitment, AuthorityId, Capabilities, Fact, FactKind, FieldAttestation,
		FieldKey, FieldValue, Identity, Method, Note, ReasonCode, Target, Value, Verdict,
	},
	validate, Authorities, Config, Error, Event, Facts, FieldAttestations, Identities, Pallet,
	PendingCount, PendingRequests,
};
use frame_support::{dispatch::DispatchResult, ensure};
use frame_system::pallet_prelude::BlockNumberFor;
use sp_core::H256;
use sp_runtime::DispatchError;

/// What the attestations of one field say, and what reading them cost.
#[derive(Default, Clone, Copy, Debug)]
pub(crate) struct FieldVerdicts {
	/// Some authority has a valid `Verified` attestation of the field.
	pub verified: bool,
	/// Some authority has a valid `Rejected` attestation of the field.
	pub rejected: bool,
	/// Number of attestations of the field, valid or not: the entries that were read.
	pub attestations: u32,
}

impl<T: Config> Pallet<T> {
	/// Ask `authority` to check `target` on the identity of `who`.
	pub(crate) fn do_request_judgement(
		who: &T::AccountId,
		authority: AuthorityId,
		target: Target,
	) -> DispatchResult {
		ensure!(Identities::<T>::contains_key(who), Error::<T>::NoIdentity);
		let info = Authorities::<T>::get(authority).ok_or(Error::<T>::UnknownAuthority)?;
		ensure!(info.active, Error::<T>::AuthorityInactive);
		let request = (authority, target.clone());
		ensure!(!PendingRequests::<T>::contains_key(who, &request), Error::<T>::RequestExists);
		PendingCount::<T>::try_mutate(who, |count| -> DispatchResult {
			ensure!(*count < MAX_PENDING_REQUESTS, Error::<T>::TooManyRequests);
			*count += 1;
			Ok(())
		})?;
		PendingRequests::<T>::insert(who, request, frame_system::Pallet::<T>::block_number());
		Self::deposit_event(Event::AttestationRequested { who: who.clone(), authority, target });
		Ok(())
	}

	/// Withdraw a request of `who`.
	pub(crate) fn do_cancel_request(
		who: &T::AccountId,
		authority: AuthorityId,
		target: Target,
	) -> DispatchResult {
		ensure!(Self::take_request(who, authority, &target), Error::<T>::UnknownRequest);
		Self::deposit_event(Event::RequestCancelled { who: who.clone(), authority, target });
		Ok(())
	}

	/// Record the verdict of `agent`'s authority on field `key` of `who`, checked against the
	/// value whose commitment is `expected_commitment`.
	///
	/// Fails with `StaleCommitment` if the field changed since the agent checked it, so an
	/// attestation always matches the value it was made for at the time it is written.
	pub(crate) fn do_provide_judgement(
		agent: &T::AccountId,
		who: T::AccountId,
		key: FieldKey,
		expected_commitment: H256,
		verdict: Verdict,
		method: Method,
		expires_at: Option<BlockNumberFor<T>>,
	) -> DispatchResult {
		let authority = Self::ensure_agent(agent, Capabilities::ATTEST_FIELDS)?;
		ensure!(
			!matches!(method, Method::MigratedFromPeopleChain { .. }),
			Error::<T>::MethodReserved
		);
		let now = frame_system::Pallet::<T>::block_number();
		Self::ensure_future(expires_at, now)?;
		let current = Self::current_commitment(&who, &key).ok_or(Error::<T>::FieldNotFound)?;
		ensure!(current == expected_commitment, Error::<T>::StaleCommitment);
		FieldAttestations::<T>::insert(
			(&who, &key, authority),
			FieldAttestation {
				commitment: current,
				verdict,
				method,
				issued_at: now,
				expires_at,
				revoked: None,
			},
		);
		Self::take_request(&who, authority, &Target::Field(key.clone()));
		Self::deposit_event(Event::FieldAttested {
			who,
			key,
			authority,
			verdict,
			agent: agent.clone(),
		});
		Ok(())
	}

	/// Revoke the attestation of field `key` of `who` made by `agent`'s authority.
	pub(crate) fn do_revoke_attestation(
		agent: &T::AccountId,
		who: T::AccountId,
		key: FieldKey,
		reason: ReasonCode,
	) -> DispatchResult {
		let authority = Self::ensure_agent(agent, Capabilities::ATTEST_FIELDS)?;
		let now = frame_system::Pallet::<T>::block_number();
		FieldAttestations::<T>::try_mutate((&who, &key, authority), |slot| -> DispatchResult {
			let att = slot.as_mut().ok_or(Error::<T>::UnknownAttestation)?;
			ensure!(att.revoked.is_none(), Error::<T>::AlreadyRevoked);
			att.revoked = Some((now, reason));
			Ok(())
		})?;
		Self::deposit_event(Event::AttestationRevoked {
			who,
			key,
			authority,
			reason,
			agent: agent.clone(),
		});
		Ok(())
	}

	/// Refuse the request of `who` to `agent`'s authority for `target`, with a reason and a note
	/// carried by the event.
	pub(crate) fn do_reject_request(
		agent: &T::AccountId,
		who: T::AccountId,
		target: Target,
		reason: ReasonCode,
		note: Note,
	) -> DispatchResult {
		let authority = Self::ensure_agent(agent, Self::target_capability(&target))?;
		ensure!(validate::is_utf8(&note), Error::<T>::InvalidUtf8);
		ensure!(Self::take_request(&who, authority, &target), Error::<T>::UnknownRequest);
		Self::deposit_event(Event::RequestRejected {
			who,
			authority,
			target,
			reason,
			note,
			agent: agent.clone(),
		});
		Ok(())
	}

	/// Record a fact of `kind` about the person behind the identity of `who`.
	pub(crate) fn do_grant_fact(
		agent: &T::AccountId,
		who: T::AccountId,
		kind: FactKind,
		expires_at: Option<BlockNumberFor<T>>,
		reason: ReasonCode,
		note: Note,
	) -> DispatchResult {
		let authority = Self::ensure_agent(agent, Capabilities::PERSON_FACTS)?;
		ensure!(Identities::<T>::contains_key(&who), Error::<T>::NoIdentity);
		ensure!(validate::is_utf8(&note), Error::<T>::InvalidUtf8);
		let now = frame_system::Pallet::<T>::block_number();
		Self::ensure_future(expires_at, now)?;
		Facts::<T>::insert(
			&who,
			(kind, authority),
			Fact { issued_at: now, expires_at, reason, note, revoked: None },
		);
		Self::take_request(&who, authority, &Target::Fact(kind));
		Self::deposit_event(Event::FactGranted { who, kind, authority, agent: agent.clone() });
		Ok(())
	}

	/// Revoke the fact of `kind` about `who` recorded by `agent`'s authority.
	pub(crate) fn do_revoke_fact(
		agent: &T::AccountId,
		who: T::AccountId,
		kind: FactKind,
		reason: ReasonCode,
	) -> DispatchResult {
		let authority = Self::ensure_agent(agent, Capabilities::PERSON_FACTS)?;
		let now = frame_system::Pallet::<T>::block_number();
		Facts::<T>::try_mutate(&who, (kind, authority), |slot| -> DispatchResult {
			let fact = slot.as_mut().ok_or(Error::<T>::UnknownFact)?;
			ensure!(fact.revoked.is_none(), Error::<T>::AlreadyRevoked);
			fact.revoked = Some((now, reason));
			Ok(())
		})?;
		Self::deposit_event(Event::FactRevoked {
			who,
			kind,
			authority,
			reason,
			agent: agent.clone(),
		});
		Ok(())
	}

	/// Whether `att`, the attestation of field `key` of `who`, is valid at block `now`: not
	/// revoked, not expired (valid up to and including `expires_at`), and the field still has
	/// the attested commitment. An absent field makes it invalid. The verdict is not looked at:
	/// a valid `Rejected` attestation is a valid refusal.
	pub fn attestation_is_valid(
		who: &T::AccountId,
		key: &FieldKey,
		att: &FieldAttestation<BlockNumberFor<T>>,
		now: BlockNumberFor<T>,
	) -> bool {
		Self::attestation_is_valid_against(att, Self::current_commitment(who, key), now)
	}

	/// [`Self::attestation_is_valid`] for a caller that already holds the identity: `current`
	/// is the commitment of the attested field as it is now ([`Self::commitment_in`]), `None`
	/// if the field is absent.
	pub(crate) fn attestation_is_valid_against(
		att: &FieldAttestation<BlockNumberFor<T>>,
		current: Option<H256>,
		now: BlockNumberFor<T>,
	) -> bool {
		att.revoked.is_none()
			&& !has_expired(att.expires_at, now)
			&& current == Some(att.commitment)
	}

	/// The verdicts on field `key` of `who` at block `now`; `identity` is the identity of `who`.
	/// Reads the attestations of that one field: at most one per authority.
	pub(crate) fn field_verdicts(
		who: &T::AccountId,
		identity: &Identity<BlockNumberFor<T>>,
		key: &FieldKey,
		now: BlockNumberFor<T>,
	) -> FieldVerdicts {
		let current = Self::commitment_in(identity, key);
		let mut verdicts = FieldVerdicts::default();
		for (_authority, att) in FieldAttestations::<T>::iter_prefix((who, key)) {
			verdicts.attestations += 1;
			if Self::attestation_is_valid_against(&att, current, now) {
				match att.verdict {
					Verdict::Verified => verdicts.verified = true,
					Verdict::Rejected => verdicts.rejected = true,
				}
			}
		}
		verdicts
	}

	/// Whether `fact` is active at block `now`: not revoked and not expired (active up to and
	/// including `expires_at`).
	pub fn fact_is_active(fact: &Fact<BlockNumberFor<T>>, now: BlockNumberFor<T>) -> bool {
		fact.revoked.is_none() && !has_expired(fact.expires_at, now)
	}

	/// The commitment of field `key` of `who` as it is now, `None` if absent. See the module
	/// documentation for links.
	pub fn current_commitment(who: &T::AccountId, key: &FieldKey) -> Option<H256> {
		Self::commitment_in(&Identities::<T>::get(who)?, key)
	}

	/// The commitment of field `key` in `identity`, `None` if absent.
	pub(crate) fn commitment_in(
		identity: &Identity<BlockNumberFor<T>>,
		key: &FieldKey,
	) -> Option<H256> {
		match key {
			FieldKey::Typed(kind) => identity.typed.get(kind).map(commitment),
			FieldKey::Custom(custom) => identity.custom.get(custom).map(commitment),
			FieldKey::Link(id) => identity
				.links
				.iter()
				.find(|link| link.id == *id)
				.map(|link| link_commitment(&link.title, &link.url)),
		}
	}

	/// The capability an agent needs to act on `target`.
	pub fn target_capability(target: &Target) -> Capabilities {
		match target {
			Target::Field(_) => Capabilities::ATTEST_FIELDS,
			Target::Fact(_) => Capabilities::PERSON_FACTS,
		}
	}

	/// After field `key` of `who` was revealed from the private commitment `old` to `value`,
	/// move the attestations of that commitment to the public one, so they stay valid. The
	/// others (of an older value) are left as they are.
	///
	/// Iterates the attestations of this one field: at most one per authority.
	pub(crate) fn on_field_revealed(who: &T::AccountId, key: &FieldKey, old: H256, value: &Value) {
		let revealed = commitment(&FieldValue::Public(value.clone()));
		let matching: alloc::vec::Vec<AuthorityId> =
			FieldAttestations::<T>::iter_prefix((who, key))
				.filter(|(_, att)| att.commitment == old)
				.map(|(authority, _)| authority)
				.collect();
		for authority in matching {
			FieldAttestations::<T>::mutate((who, key, authority), |slot| {
				if let Some(att) = slot {
					att.commitment = revealed;
				}
			});
		}
	}

	/// Delete the attestations of field `key` of `who`, removed from the identity.
	pub(crate) fn remove_field_attestations(who: &T::AccountId, key: &FieldKey) {
		// At most one per authority.
		let _ = FieldAttestations::<T>::clear_prefix((who, key), MAX_AUTHORITIES, None);
	}

	/// Delete the attestations and requests of `who`; how many of each were deleted. Run when
	/// its identity is cleared; the facts are kept (see the module documentation).
	pub(crate) fn clear_attestations(who: &T::AccountId) -> (u32, u32) {
		let attestations =
			FieldAttestations::<T>::clear_prefix((who,), MAX_ATTESTATIONS_PER_IDENTITY, None)
				.unique;
		let requests = PendingRequests::<T>::clear_prefix(who, MAX_PENDING_REQUESTS, None).unique;
		PendingCount::<T>::remove(who);
		(attestations, requests)
	}

	/// Delete the facts about `who`; how many were deleted. Run by `kill_identity` only.
	pub(crate) fn clear_facts(who: &T::AccountId) -> u32 {
		Facts::<T>::clear_prefix(who, FactKind::COUNT * MAX_AUTHORITIES, None).unique
	}

	/// Remove the request of `who` to `authority` for `target`, keeping `PendingCount` exact;
	/// whether there was one.
	fn take_request(who: &T::AccountId, authority: AuthorityId, target: &Target) -> bool {
		if PendingRequests::<T>::take(who, (authority, target)).is_none() {
			return false;
		}
		PendingCount::<T>::mutate_exists(who, |count| {
			*count = count.and_then(|n| n.checked_sub(1)).filter(|n| *n > 0);
		});
		true
	}

	/// An expiry, when given, must be a block after `now`.
	fn ensure_future(
		expires_at: Option<BlockNumberFor<T>>,
		now: BlockNumberFor<T>,
	) -> Result<(), DispatchError> {
		ensure!(expires_at.is_none_or(|end| end > now), Error::<T>::ExpiryNotInFuture);
		Ok(())
	}
}

/// Whether something valid up to and including `expires_at` (forever if `None`) has expired at
/// block `now`. The one expiry rule of attestations and facts.
fn has_expired<B: PartialOrd>(expires_at: Option<B>, now: B) -> bool {
	expires_at.is_some_and(|end| now > end)
}
