//! Transaction extensions specific to identitee.

use codec::{Decode, DecodeWithMemTracking, Encode};
use frame_support::{
	dispatch::{CheckIfFeeless, DispatchInfo},
	pallet_prelude::TransactionSource,
	traits::{Get, IsSubType},
	DebugNoBound,
};
use frame_system::{CheckNonce, ValidNonceInfo};
use pallet_identitee::WeightInfo as _;
use scale_info::TypeInfo;
use sp_runtime::{
	traits::{
		AsSystemOriginSigner, DispatchInfoOf, Dispatchable, One, PostDispatchInfoOf,
		TransactionExtension, ValidateResult, Zero,
	},
	transaction_validity::{
		InvalidTransaction, TransactionLongevity, TransactionValidityError, ValidTransaction,
	},
	DispatchResult, Saturating, Weight,
};

/// `frame_system::CheckNonce`, extended so that a never-funded account can make feeless calls.
///
/// Upstream `CheckNonce` rejects any account with neither providers nor sufficients
/// (`InvalidTransaction::Payment`): such an account cannot pay for its own `System::Account`
/// entry. When the call is feeless for the signing origin, this extension accepts the account
/// anyway and, at prepare time, bumps the nonce, then gives it a provider reference
/// (`inc_providers`) and records it with `pallet_identitee::Pallet::note_onboarded`.
///
/// It also records every feeless identitee user call against the quotas
/// (`pallet_identitee::Pallet::note_usage`), at prepare time so that a call whose dispatch fails
/// still counts, and defers (`ExhaustsResources`) a user call refused only by the per-block cap.
/// Every other transaction is handled exactly like upstream `CheckNonce`.
///
/// For wallets it *is* `CheckNonce`: same `IDENTIFIER`, same encoding (a compact nonce), same
/// (empty) implicit data, so polkadot.js signs without any custom type.
#[derive(Encode, Decode, DecodeWithMemTracking, Clone, Eq, PartialEq, TypeInfo)]
#[scale_info(skip_type_params(T))]
pub struct CheckNonceOnboard<T: frame_system::Config>(#[codec(compact)] pub T::Nonce);

impl<T: frame_system::Config> CheckNonceOnboard<T> {
	/// Utility constructor, mirroring `CheckNonce::from`.
	pub fn from(nonce: T::Nonce) -> Self {
		Self(nonce)
	}
}

impl<T: frame_system::Config> core::fmt::Debug for CheckNonceOnboard<T> {
	#[cfg(feature = "std")]
	fn fmt(&self, f: &mut core::fmt::Formatter) -> core::fmt::Result {
		write!(f, "CheckNonceOnboard({})", self.0)
	}

	#[cfg(not(feature = "std"))]
	fn fmt(&self, _: &mut core::fmt::Formatter) -> core::fmt::Result {
		Ok(())
	}
}

/// Outcome of `validate`, consumed by `prepare`.
#[derive(DebugNoBound)]
pub enum Val<T: frame_system::Config> {
	/// Signed transaction: check and bump the nonce as upstream, then apply the side effects.
	Signed {
		who: T::AccountId,
		/// The account has no providers nor sufficients and the call is feeless: give it a
		/// provider reference.
		onboard: bool,
		/// The call is a feeless identitee user call: record it against the quotas.
		note_usage: bool,
	},
	/// Not a signed transaction: nothing to do, refund the weight.
	Refund(Weight),
}

/// Outcome of `prepare`, consumed by `post_dispatch_details`.
#[derive(DebugNoBound)]
pub enum Pre {
	/// The nonce was checked: keep the weight.
	NonceChecked,
	/// Nothing was done: refund this weight.
	Refund(Weight),
}

impl<T> CheckNonceOnboard<T>
where
	T: frame_system::Config + pallet_identitee::Config,
	T::RuntimeCall: IsSubType<pallet_identitee::Call<T>>,
{
	/// Whether `who` has no reference keeping its account alive.
	fn is_unbacked(who: &T::AccountId) -> bool {
		let account = frame_system::Account::<T>::get(who);
		account.providers.is_zero() && account.sufficients.is_zero()
	}

	/// Whether `call` is an identitee user call, subject to the feeless quotas.
	fn is_user_call(call: &T::RuntimeCall) -> bool {
		call.is_sub_type().is_some_and(|call| call.counts_against_quota())
	}

	/// Same `provides`/`requires` as `CheckNonce::validate_nonce_for_account`, without the
	/// providers/sufficients requirement. Read-only.
	fn validate_onboarding_nonce(
		who: &T::AccountId,
		nonce: T::Nonce,
	) -> Result<ValidNonceInfo, TransactionValidityError> {
		let account_nonce = frame_system::Account::<T>::get(who).nonce;
		if nonce < account_nonce {
			return Err(InvalidTransaction::Stale.into());
		}
		let provides = alloc::vec![Encode::encode(&(who.clone(), nonce))];
		let requires = if account_nonce < nonce {
			alloc::vec![Encode::encode(&(who.clone(), nonce.saturating_sub(One::one())))]
		} else {
			alloc::vec![]
		};
		Ok(ValidNonceInfo { provides, requires })
	}
}

impl<T> TransactionExtension<T::RuntimeCall> for CheckNonceOnboard<T>
where
	T: frame_system::Config + pallet_identitee::Config + Send + Sync,
	T::RuntimeCall: Dispatchable<Info = DispatchInfo>
		+ CheckIfFeeless<Origin = frame_system::pallet_prelude::OriginFor<T>>
		+ IsSubType<pallet_identitee::Call<T>>,
	<T::RuntimeCall as Dispatchable>::RuntimeOrigin: AsSystemOriginSigner<T::AccountId> + Clone,
{
	const IDENTIFIER: &'static str = "CheckNonce";
	type Implicit = ();
	type Val = Val<T>;
	type Pre = Pre;

	fn weight(&self, call: &T::RuntimeCall) -> Weight {
		// Upstream nonce check, plus the onboarding write (`ProviderHeld`; the provider count
		// lives in the account entry the nonce check already writes) which may happen for any
		// feeless call, plus checking and recording the quotas for identitee user calls.
		let weight = <CheckNonce<T> as TransactionExtension<T::RuntimeCall>>::weight(
			&CheckNonce(self.0),
			call,
		)
		.saturating_add(T::DbWeight::get().writes(1));
		if Self::is_user_call(call) {
			weight.saturating_add(<T as pallet_identitee::Config>::WeightInfo::note_usage())
		} else {
			weight
		}
	}

	fn validate(
		&self,
		origin: <T as frame_system::Config>::RuntimeOrigin,
		call: &T::RuntimeCall,
		_info: &DispatchInfoOf<T::RuntimeCall>,
		_len: usize,
		_self_implicit: Self::Implicit,
		_inherited_implication: &impl Encode,
		_source: TransactionSource,
	) -> ValidateResult<Self::Val, T::RuntimeCall> {
		let Some(who) = origin.as_system_origin_signer() else {
			return Ok((Default::default(), Val::Refund(self.weight(call)), origin));
		};
		let user_call = Self::is_user_call(call);
		let feeless = call.is_feeless(&origin);
		// A user call refused only because the block already holds its share of feeless calls
		// waits for the next block instead of paying or being dropped: block authors skip an
		// `ExhaustsResources` transaction but keep it in the pool.
		if user_call
			&& !feeless
			&& pallet_identitee::Pallet::<T>::quota_available(who)
			&& !pallet_identitee::Pallet::<T>::block_cap_available()
		{
			return Err(InvalidTransaction::ExhaustsResources.into());
		}
		let onboard = feeless && Self::is_unbacked(who);
		let ValidNonceInfo { provides, requires } = if onboard {
			Self::validate_onboarding_nonce(who, self.0)?
		} else {
			CheckNonce::<T>::validate_nonce_for_account(who, self.0)?
		};
		let validity = ValidTransaction {
			priority: 0,
			requires,
			provides,
			longevity: TransactionLongevity::max_value(),
			propagate: true,
		};
		let val = Val::Signed { who: who.clone(), onboard, note_usage: user_call && feeless };
		Ok((validity, val, origin))
	}

	fn prepare(
		self,
		val: Self::Val,
		_origin: &<T as frame_system::Config>::RuntimeOrigin,
		_call: &T::RuntimeCall,
		_info: &DispatchInfoOf<T::RuntimeCall>,
		_len: usize,
	) -> Result<Self::Pre, TransactionValidityError> {
		let (who, onboard, note_usage) = match val {
			Val::Signed { who, onboard, note_usage } => (who, onboard, note_usage),
			Val::Refund(weight) => return Ok(Pre::Refund(weight)),
		};
		// Nonce first: a transaction rejected here (e.g. a future nonce) leaves no state.
		CheckNonce::<T>::prepare_nonce_for_account(&who, self.0)?;
		// Validate and prepare run back to back on the same state; re-check anyway so a
		// provider is never added twice. The nonce bump above wrote the account entry but left
		// its reference counts untouched.
		if onboard && Self::is_unbacked(&who) {
			frame_system::Pallet::<T>::inc_providers(&who);
			pallet_identitee::Pallet::<T>::note_onboarded(&who);
		}
		// Recorded here, outside dispatch: a call whose dispatch fails rolls back its own
		// storage changes, but must still consume quota.
		if note_usage {
			pallet_identitee::Pallet::<T>::note_usage(&who);
		}
		Ok(Pre::NonceChecked)
	}

	fn post_dispatch_details(
		pre: Self::Pre,
		_info: &DispatchInfo,
		_post_info: &PostDispatchInfoOf<T::RuntimeCall>,
		_len: usize,
		_result: &DispatchResult,
	) -> Result<Weight, TransactionValidityError> {
		match pre {
			Pre::NonceChecked => Ok(Weight::zero()),
			Pre::Refund(weight) => Ok(weight),
		}
	}
}
