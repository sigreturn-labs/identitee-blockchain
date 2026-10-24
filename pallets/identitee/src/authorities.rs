//! Identity authorities: the registry of organisations whose agents act on identities, and the
//! capability check every agent call goes through.
//!
//! The registry is managed by `Config::AuthorityOrigin` only. An agent is a single account that
//! belongs to exactly one authority and holds a set of [`Capabilities`]. Agent calls
//! (`attestations.rs`, `names.rs`, `migration.rs`) start with [`Pallet::ensure_agent`] and are
//! feeless through [`Pallet::agent_call_feeless`] for the capability they need; neither touches
//! the user quotas.

use crate::{
	limits,
	types::{AuthorityId, AuthorityInfo, AuthorityName, Capabilities, GenesisAuthority},
	validate, Agents, Authorities, Config, Error, Event, NextAuthorityId, Pallet,
};
use frame_support::{dispatch::DispatchResult, ensure};
use frame_system::{ensure_signed, pallet_prelude::OriginFor};
use sp_runtime::DispatchError;

impl<T: Config> Pallet<T> {
	/// Register a new, active authority and give it the next id.
	pub(crate) fn do_add_authority(name: AuthorityName) -> Result<AuthorityId, DispatchError> {
		ensure!(validate::is_utf8(&name), Error::<T>::InvalidUtf8);
		let id = NextAuthorityId::<T>::get();
		// Ids are not reused, so the next id is the number of authorities ever registered.
		ensure!(id < limits::MAX_AUTHORITIES, Error::<T>::TooManyAuthorities);
		NextAuthorityId::<T>::put(id + 1);
		Authorities::<T>::insert(id, AuthorityInfo { name: name.clone(), active: true });
		Self::deposit_event(Event::AuthorityRegistered { id, name });
		Ok(id)
	}

	/// Make `agent` an agent of `authority` with the capabilities `caps`, or change the
	/// capabilities it already has there. An account serves a single authority: moving it takes
	/// a `remove_agent` first.
	pub(crate) fn do_set_agent(
		authority: AuthorityId,
		agent: T::AccountId,
		caps: u8,
	) -> DispatchResult {
		ensure!(Authorities::<T>::contains_key(authority), Error::<T>::UnknownAuthority);
		let caps = Capabilities::from_bits(caps).ok_or(Error::<T>::UnknownCapabilities)?;
		ensure!(!caps.is_empty(), Error::<T>::NoCapabilities);
		if let Some((current, _)) = Agents::<T>::get(&agent) {
			ensure!(current == authority, Error::<T>::AgentOfAnotherAuthority);
		}
		Agents::<T>::insert(&agent, (authority, caps));
		Self::deposit_event(Event::AgentSet { authority, agent, caps });
		Ok(())
	}

	/// Remove `agent` from the registry.
	pub(crate) fn do_remove_agent(agent: T::AccountId) -> DispatchResult {
		let (authority, _) = Agents::<T>::take(&agent).ok_or(Error::<T>::NotAnAgent)?;
		Self::deposit_event(Event::AgentRemoved { authority, agent });
		Ok(())
	}

	/// Activate or deactivate an authority. An inactive authority's agents cannot act.
	pub(crate) fn do_set_authority_active(authority: AuthorityId, active: bool) -> DispatchResult {
		Authorities::<T>::try_mutate(authority, |info| -> DispatchResult {
			info.as_mut().ok_or(Error::<T>::UnknownAuthority)?.active = active;
			Ok(())
		})?;
		Self::deposit_event(Event::AuthorityStatusChanged { authority, active });
		Ok(())
	}

	/// Check that `who` is an agent of an active authority and holds every capability in `cap`;
	/// give the authority it acts for. Every agent call starts with this.
	///
	/// An inactive authority is reported before a missing capability, since adding the
	/// capability would not let the agent act.
	pub fn ensure_agent(
		who: &T::AccountId,
		cap: Capabilities,
	) -> Result<AuthorityId, DispatchError> {
		let (authority, held) = Agents::<T>::get(who).ok_or(Error::<T>::NotAnAgent)?;
		ensure!(Self::authority_active(authority), Error::<T>::AuthorityInactive);
		ensure!(held.contains(cap), Error::<T>::MissingCapability);
		Ok(authority)
	}

	/// Whether an agent call from `origin` that needs the capabilities `required` is feeless:
	/// signed by an agent of an active authority holding them, exactly when
	/// [`Pallet::ensure_agent`] would accept it. Read-only, as `feeless_if` runs in the
	/// transaction pool, so an agent without the capability pays (and fails) instead of getting
	/// a free failing call. Agent calls are not recorded against the user quotas.
	pub fn agent_call_feeless(origin: &OriginFor<T>, required: Capabilities) -> bool {
		match ensure_signed(origin.clone()) {
			Ok(who) => Self::ensure_agent(&who, required).is_ok(),
			Err(_) => false,
		}
	}

	/// Whether `authority` is registered and active.
	fn authority_active(authority: AuthorityId) -> bool {
		Authorities::<T>::get(authority).is_some_and(|info| info.active)
	}

	/// Seed the registry at genesis. Ids are given in order from 0; a configuration that could
	/// not be applied by the calls (unknown capability, an account serving two authorities, a
	/// name that is too long) aborts the genesis build with a message naming the entry.
	pub(crate) fn build_authorities(authorities: &[GenesisAuthority<T::AccountId>]) {
		for (index, authority) in authorities.iter().enumerate() {
			let entry = alloc::format!("authority #{index} {:?}", authority.name);
			let name = AuthorityName::try_from(authority.name.as_bytes().to_vec())
				.unwrap_or_else(|_| panic!("identitee genesis: {entry}: name too long"));
			let id = Self::do_add_authority(name)
				.unwrap_or_else(|e| panic!("identitee genesis: {entry}: {}", error_name(e)));
			for agent in &authority.agents {
				Self::do_set_agent(id, agent.account.clone(), agent.caps).unwrap_or_else(|e| {
					panic!(
						"identitee genesis: {entry}: agent {:?}: {}",
						agent.account,
						error_name(e)
					)
				});
			}
		}
	}
}

/// The name of a pallet error (`"NoCapabilities"`), for the genesis panic messages.
fn error_name(error: DispatchError) -> &'static str {
	error.into()
}
