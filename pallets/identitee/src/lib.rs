//! # Identitee pallet
//!
//! On-chain identity profiles. This file is a thin FRAME shell: configuration, storage, events,
//! errors and call entry points. The logic lives in the sibling modules.
//!
//! Identity writes are feeless (`#[pallet::feeless_if]`), and a never-funded account can make
//! them: the runtime's `CheckNonceOnboard` extension gives such an account a provider reference
//! on its first feeless call and records it here with [`Pallet::note_onboarded`].
//!
//! Feeless user calls are limited per account and window and per block (`quota.rs`); the same
//! extension records each one with [`Pallet::note_usage`].
//!
//! Identity authorities are registered by `Config::AuthorityOrigin`, each with agents that hold
//! capabilities (`authorities.rs`). Agent calls are feeless for the agents of an active
//! authority holding the capability the call needs ([`Pallet::agent_call_feeless`]) and outside
//! the user quotas.
//!
//! People ask authorities to check their fields or record facts about them, and the agents
//! attest fields, record facts, revoke them and refuse requests (`attestations.rs`).
//!
//! The trust level of an identity is computed from them on demand, never stored
//! ([`Pallet::trust_level_of`], `trust.rs`).
//!
//! An identity may hold one native name, claimed once a field of it is verified, kept for good
//! and put in quarantine when it leaves its owner (`names.rs`). Authorities reserve names,
//! assign them and take them away.
//!
//! A parent proposes sub-accounts and each sub accepts or declines (`subs.rs`); either side can end
//! a link. A proposal does not tie its target down, a sub-account needs no identity of its own,
//! and the tree has one level.
//!
//! A person without an identity may ask to bring theirs over from a People Chain
//! (`migration.rs`). An agent holding the migrate capability imports it, and the runtime maps
//! the dotID judgement it carries to attestations and facts by a fixed table.
//!
//! An account may keep one encrypted blob on chain, its identity secret, from which the client
//! derives the salts of its private fields. The chain stores the bytes and never reads them
//! (`content.rs`); they belong to the account, not to the identity.
//!
//! Clients read profiles, trust levels, names, sub-accounts and the identity secret through the
//! `IdentiteeApi` runtime API (`runtime_api.rs`), whose views are built on demand (`views.rs`).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

mod attestations;
mod authorities;
mod content;
pub mod limits;
pub mod migration;
mod names;
mod quota;
pub mod runtime_api;
mod subs;
pub mod trust;
pub mod types;
pub mod validate;
pub mod views;
pub mod weights;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub use weights::WeightInfo;

#[frame_support::pallet]
pub mod pallet {
	use super::{
		limits,
		types::{
			AuthorityId, AuthorityInfo, AuthorityName, AvatarBytes, Bio, Capabilities, Fact,
			FactKind, FieldAttestation, FieldChanges, FieldKey, FieldValue, GenesisAuthority,
			Identity, ImportedJudgements, LinkIds, LinkTitle, MaxSubs, Method, MigrationPayload,
			Name, Note, ProfileUpdate, ReasonCode, SecretBlob, SourceChain, SubLabel, Target,
			Value, Verdict,
		},
		WeightInfo,
	};
	use alloc::vec::Vec;
	use frame_support::{
		dispatch::{DispatchErrorWithPostInfo, PostDispatchInfo},
		pallet_prelude::*,
	};
	use frame_system::pallet_prelude::*;
	use sp_core::H256;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// The overarching event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// Weight information for the calls of this pallet.
		type WeightInfo: WeightInfo;
		/// Origin allowed to manage authorities.
		type AuthorityOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// Length of a quota window, in blocks (one day on the real runtime).
		#[pallet::constant]
		type QuotaWindow: Get<BlockNumberFor<Self>>;
		/// Time a released or revoked name stays unclaimable, in blocks (30 days on the real
		/// runtime).
		#[pallet::constant]
		type NameQuarantine: Get<BlockNumberFor<Self>>;
	}

	/// Identity profile of each account.
	#[pallet::storage]
	pub type Identities<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, Identity<BlockNumberFor<T>>>;

	/// Accounts that received a provider reference when onboarded by a feeless call.
	#[pallet::storage]
	pub type ProviderHeld<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, ()>;

	/// Feeless user calls of each account in its current quota window:
	/// `(block the window opened, calls made in it)`.
	#[pallet::storage]
	pub type Usage<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, (BlockNumberFor<T>, u32)>;

	/// Feeless user calls applied in the current block, all accounts together. Cleared when the
	/// block ends, so the state the transaction pool validates against starts from zero.
	#[pallet::storage]
	pub type BlockFeelessOps<T: Config> = StorageValue<_, u32, ValueQuery>;

	/// Registered identity authorities.
	#[pallet::storage]
	pub type Authorities<T: Config> = StorageMap<_, Blake2_128Concat, AuthorityId, AuthorityInfo>;

	/// Id given to the next registered authority.
	#[pallet::storage]
	pub type NextAuthorityId<T: Config> = StorageValue<_, AuthorityId, ValueQuery>;

	/// The agents of the authorities: the authority each serves and its capabilities.
	#[pallet::storage]
	pub type Agents<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, (AuthorityId, Capabilities)>;

	/// Field attestations, per account, field and attesting authority.
	///
	/// A map with three keys rather than two, so the attestations of one field can be listed
	/// by prefix (`reveal_field` updates them).
	#[pallet::storage]
	pub type FieldAttestations<T: Config> = StorageNMap<
		_,
		(
			NMapKey<Blake2_128Concat, T::AccountId>,
			NMapKey<Blake2_128Concat, FieldKey>,
			NMapKey<Blake2_128Concat, AuthorityId>,
		),
		FieldAttestation<BlockNumberFor<T>>,
	>;

	/// Facts about the person behind an identity, per account and (kind, recording authority).
	#[pallet::storage]
	pub type Facts<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		T::AccountId,
		Blake2_128Concat,
		(FactKind, AuthorityId),
		Fact<BlockNumberFor<T>>,
	>;

	/// Pending attestation requests, per account and (authority, target): the block of the
	/// request.
	#[pallet::storage]
	pub type PendingRequests<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		T::AccountId,
		Blake2_128Concat,
		(AuthorityId, Target),
		BlockNumberFor<T>,
	>;

	/// Number of `PendingRequests` entries of each account, at most `MaxPendingRequests`.
	#[pallet::storage]
	pub type PendingCount<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

	/// The account owning each native name.
	#[pallet::storage]
	pub type NameOwner<T: Config> = StorageMap<_, Blake2_128Concat, Name, T::AccountId>;

	/// The native name of each account, the reverse of `NameOwner`: an account has at most one.
	#[pallet::storage]
	pub type NameOf<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, Name>;

	/// Names only an authority can assign. Never a name that someone owns.
	#[pallet::storage]
	pub type Reserved<T: Config> = StorageMap<_, Blake2_128Concat, Name, ()>;

	/// The block of the last voluntary `release_username` of each account, until its next
	/// `claim_username` (which deletes the entry). An account cannot claim a name for
	/// `QuotaWindow` blocks after it.
	#[pallet::storage]
	pub type LastRelease<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, BlockNumberFor<T>>;

	/// Names released or revoked, with the block from which they can be claimed again. Entries
	/// whose block has passed are removed when the name is next claimed or assigned.
	#[pallet::storage]
	pub type Quarantine<T: Config> = StorageMap<_, Blake2_128Concat, Name, BlockNumberFor<T>>;

	/// The accepted parent link of each sub-account: `(parent, label given by the parent)`. An
	/// account has at most one. One level only: an account is never both an accepted sub and the
	/// parent of accepted subs (checked when a proposal is accepted).
	#[pallet::storage]
	pub type SubOf<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, (T::AccountId, SubLabel)>;

	/// The proposals a sub has not accepted yet, per sub and proposing parent, with the label. Any
	/// number of parents can propose the same account: a proposal does not tie the account down.
	#[pallet::storage]
	pub type SubProposals<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		T::AccountId,
		Blake2_128Concat,
		T::AccountId,
		SubLabel,
	>;

	/// The subs of each parent, accepted ones and pending proposals together, in the order they
	/// were proposed: `SubsOf[p]` contains `s` exactly when `SubOf[s]` names `p` or
	/// `SubProposals[(s, p)]` exists. The list bounds what one parent can hold, whatever the
	/// state of each link. An empty list is never stored.
	#[pallet::storage]
	pub type SubsOf<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, BoundedVec<T::AccountId, MaxSubs>>;

	/// Pending migration requests: the chain to migrate from and the block of the request. One
	/// per account, made while the account has no identity.
	#[pallet::storage]
	pub type MigrationRequests<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, (SourceChain, BlockNumberFor<T>)>;

	/// Provenance of a migrated identity: the source chain, the source block and its hash, and
	/// every registrar judgement as read there. Kept when the identity is cleared (and then bars
	/// a second migration), deleted by `kill_identity`.
	#[pallet::storage]
	pub type ImportedHistory<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, (SourceChain, u32, H256, ImportedJudgements)>;

	/// The encrypted identity secret of each account that stored one: opaque bytes, produced and
	/// read by the client. Kept when the identity is cleared, deleted by `kill_identity`.
	#[pallet::storage]
	pub type IdentitySecrets<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, SecretBlob>;

	/// Authorities and agents present at genesis. Ids are given in order from 0.
	#[pallet::genesis_config]
	#[derive(frame_support::DefaultNoBound)]
	pub struct GenesisConfig<T: Config> {
		/// Each authority with its name and its agents (see [`GenesisAuthority`]).
		pub authorities: Vec<GenesisAuthority<T::AccountId>>,
	}

	#[pallet::genesis_build]
	impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
		fn build(&self) {
			Pallet::<T>::build_authorities(&self.authorities);
		}
	}

	#[pallet::hooks]
	impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
		fn on_initialize(_n: BlockNumberFor<T>) -> Weight {
			// Accounts for the `BlockFeelessOps` removal in `on_finalize`.
			T::DbWeight::get().writes(1)
		}

		fn on_finalize(_n: BlockNumberFor<T>) {
			BlockFeelessOps::<T>::kill();
		}
	}

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// The bio of an identity was set.
		BioSet { who: T::AccountId },
		/// A typed or custom field was set.
		FieldSet { who: T::AccountId, key: FieldKey },
		/// A typed or custom field was cleared.
		FieldCleared { who: T::AccountId, key: FieldKey },
		/// A link was added.
		LinkAdded { who: T::AccountId, id: u32 },
		/// A link was updated.
		LinkUpdated { who: T::AccountId, id: u32 },
		/// A link was removed.
		LinkRemoved { who: T::AccountId, id: u32 },
		/// The links were reordered.
		LinksReordered { who: T::AccountId },
		/// The avatar was set.
		AvatarSet { who: T::AccountId },
		/// The avatar was cleared.
		AvatarCleared { who: T::AccountId },
		/// A private field was revealed and is now public.
		FieldRevealed { who: T::AccountId, key: FieldKey },
		/// The owner cleared their identity.
		IdentityCleared { who: T::AccountId },
		/// The authority origin purged an identity.
		IdentityPurged { who: T::AccountId },
		/// An identity authority was registered.
		AuthorityRegistered { id: AuthorityId, name: AuthorityName },
		/// An agent was added to an authority, or its capabilities changed.
		AgentSet { authority: AuthorityId, agent: T::AccountId, caps: Capabilities },
		/// An agent was removed.
		AgentRemoved { authority: AuthorityId, agent: T::AccountId },
		/// An authority was activated or deactivated.
		AuthorityStatusChanged { authority: AuthorityId, active: bool },
		/// An account asked an authority to check a field or record a fact.
		AttestationRequested { who: T::AccountId, authority: AuthorityId, target: Target },
		/// An account withdrew a request.
		RequestCancelled { who: T::AccountId, authority: AuthorityId, target: Target },
		/// An agent recorded its authority's verdict on a field.
		FieldAttested {
			who: T::AccountId,
			key: FieldKey,
			authority: AuthorityId,
			verdict: Verdict,
			agent: T::AccountId,
		},
		/// An agent revoked its authority's attestation of a field.
		AttestationRevoked {
			who: T::AccountId,
			key: FieldKey,
			authority: AuthorityId,
			reason: ReasonCode,
			agent: T::AccountId,
		},
		/// An agent refused a request made to its authority.
		RequestRejected {
			who: T::AccountId,
			authority: AuthorityId,
			target: Target,
			reason: ReasonCode,
			note: Note,
			agent: T::AccountId,
		},
		/// An agent recorded a fact about the person behind an identity.
		FactGranted {
			who: T::AccountId,
			kind: FactKind,
			authority: AuthorityId,
			agent: T::AccountId,
		},
		/// An agent revoked a fact its authority recorded.
		FactRevoked {
			who: T::AccountId,
			kind: FactKind,
			authority: AuthorityId,
			reason: ReasonCode,
			agent: T::AccountId,
		},
		/// An account claimed a name.
		NameClaimed { who: T::AccountId, name: Name },
		/// A name left its owner, who released it or cleared their identity. It is in quarantine.
		NameReleased { who: T::AccountId, name: Name },
		/// An agent reserved a name.
		NameReserved { name: Name },
		/// An agent lifted the reservation of a name.
		NameUnreserved { name: Name },
		/// An agent gave a name to an account.
		NameAssigned { who: T::AccountId, name: Name },
		/// An agent took a name away from its owner. It is in quarantine.
		NameRevoked { who: T::AccountId, name: Name, reason: ReasonCode },
		/// A parent proposed a sub-account. It is linked once the sub accepts.
		SubProposed { parent: T::AccountId, sub: T::AccountId },
		/// A sub-account accepted the proposal of its parent.
		SubAccepted { parent: T::AccountId, sub: T::AccountId },
		/// A link between a parent and a sub-account, accepted or still a proposal, ended on the
		/// parent's side: it removed the sub, or its identity was cleared.
		SubRemoved { parent: T::AccountId, sub: T::AccountId },
		/// A sub-account left its parent.
		SubLeft { parent: T::AccountId, sub: T::AccountId },
		/// A sub-account refused a proposal.
		SubDeclined { parent: T::AccountId, sub: T::AccountId },
		/// A parent changed the label of a sub-account.
		SubLabelSet { parent: T::AccountId, sub: T::AccountId },
		/// An account asked for the migration of its identity from a People Chain.
		MigrationRequested { who: T::AccountId, source: SourceChain },
		/// An account withdrew its migration request.
		MigrationCancelled { who: T::AccountId, source: SourceChain },
		/// An agent imported the identity of `who` from `source`, read at block `block` whose
		/// hash is `block_hash`, so anyone can check it against the source chain.
		MigrationFulfilled {
			who: T::AccountId,
			source: SourceChain,
			block: u32,
			block_hash: H256,
			agent: T::AccountId,
		},
		/// An agent refused a migration request.
		MigrationRejected {
			who: T::AccountId,
			source: SourceChain,
			reason: ReasonCode,
			agent: T::AccountId,
		},
		/// An account stored its encrypted identity secret (the blob is not in the event).
		IdentitySecretSet { who: T::AccountId },
		/// An account deleted its encrypted identity secret.
		IdentitySecretCleared { who: T::AccountId },
		/// An account updated its profile with `update_profile`, after the events of each change
		/// it made.
		ProfileUpdated { who: T::AccountId },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// A public text value is not valid UTF-8.
		InvalidUtf8,
		/// A PGP fingerprint is not 20 or 32 bytes long.
		InvalidPgp,
		/// The avatar is not a WebP image of an accepted size.
		InvalidAvatar,
		/// The identity already has the maximum number of custom fields.
		TooManyCustomFields,
		/// The identity already has the maximum number of links.
		TooManyLinks,
		/// No link has this id.
		UnknownLink,
		/// The ids given are not a permutation of the current links.
		InvalidLinkOrder,
		/// The account has no identity.
		NoIdentity,
		/// The field is absent or already public.
		NotPrivate,
		/// The value and salt do not match the commitment of the field.
		RevealMismatch,
		/// Links are managed with the link calls, not as fields.
		LinkKeyNotSettable,
		/// No authority is registered under this id.
		UnknownAuthority,
		/// The maximum number of authorities is registered.
		TooManyAuthorities,
		/// The account is not an agent of any authority.
		NotAnAgent,
		/// The agent lacks a capability this call needs.
		MissingCapability,
		/// The agent's authority is not active.
		AuthorityInactive,
		/// An agent needs at least one capability.
		NoCapabilities,
		/// The capability bits include one that does not exist.
		UnknownCapabilities,
		/// The account is already an agent of another authority; remove it there first.
		AgentOfAnotherAuthority,
		/// The account already has a pending request to this authority for this target.
		RequestExists,
		/// The account has the maximum number of pending requests.
		TooManyRequests,
		/// No such pending request.
		UnknownRequest,
		/// The field to attest is absent.
		FieldNotFound,
		/// The field changed since the agent checked it: its commitment is not the expected one.
		StaleCommitment,
		/// An expiry must be a block after the current one.
		ExpiryNotInFuture,
		/// This method is set by the migration only.
		MethodReserved,
		/// The agent's authority has no attestation of this field.
		UnknownAttestation,
		/// The agent's authority has recorded no such fact.
		UnknownFact,
		/// The attestation or fact is already revoked.
		AlreadyRevoked,
		/// A name is shorter than `NameMin` bytes.
		NameTooShort,
		/// A name is longer than `NameMax` bytes.
		NameTooLong,
		/// A name has a character outside `a-z`, `0-9`, `-` and `_`.
		NameInvalidChar,
		/// The name belongs to someone.
		NameTaken,
		/// The name is reserved: only an authority can assign it.
		NameIsReserved,
		/// The name was released or revoked recently and cannot be taken yet.
		NameInQuarantine,
		/// The account already has a name.
		AlreadyHasName,
		/// The account has no name.
		NoName,
		/// Claiming a name needs a field with a valid verified attestation and no valid rejection.
		NoVerifiedField,
		/// The account released its name less than a quota window ago and cannot claim one yet.
		ClaimCooldown,
		/// The name is already reserved.
		AlreadyReserved,
		/// The name is not reserved.
		NotReserved,
		/// An account cannot be its own sub-account.
		SubIsSelf,
		/// The account is a sub-account of the caller already, or has a proposal from it.
		AlreadyProposed,
		/// The caller is an accepted sub-account: it cannot have sub-accounts.
		ParentIsSub,
		/// The caller has accepted sub-accounts: it cannot be one itself.
		SubIsParent,
		/// The caller already has the maximum number of sub-accounts and proposals.
		TooManySubs,
		/// The caller has no proposal from this parent.
		NoSuchProposal,
		/// The caller has a parent already: leave it before accepting another.
		AlreadyHasParent,
		/// The account is not a sub-account of the caller, nor proposed as one.
		NotYourSub,
		/// The caller has no parent.
		NoParent,
		/// The account has an identity already: a migration only creates one.
		IdentityExists,
		/// The account has a pending migration request already.
		MigrationRequestExists,
		/// The account has no pending migration request.
		NoMigrationRequest,
		/// The migration request is for another source chain.
		MigrationSourceMismatch,
		/// A migration payload gives the same field twice.
		DuplicateField,
		/// A migration payload gives two judgements of the same registrar.
		DuplicateJudgement,
		/// A `set_identity` call changes the same field twice.
		DuplicateFieldInBatch,
		/// The account migrated its identity already; only a purge by Root allows another import.
		AlreadyMigrated,
		/// An authority found fraud about the person: no name can be claimed while it stands.
		FraudFlagged,
		/// The identity secret to store is empty: clear it instead.
		EmptySecretBlob,
		/// An `update_profile` call that changes nothing.
		EmptyUpdate,
	}

	#[pallet::extra_constants]
	impl<T: Config> Pallet<T> {
		#[pallet::constant_name(MaxValueLen)]
		fn max_value_len() -> u32 {
			limits::MAX_VALUE_LEN
		}
		#[pallet::constant_name(MaxCustomKeyLen)]
		fn max_custom_key_len() -> u32 {
			limits::MAX_CUSTOM_KEY_LEN
		}
		#[pallet::constant_name(MaxCustomFields)]
		fn max_custom_fields() -> u32 {
			limits::MAX_CUSTOM_FIELDS
		}
		#[pallet::constant_name(MaxFieldChanges)]
		fn max_field_changes() -> u32 {
			limits::MAX_FIELD_CHANGES
		}
		#[pallet::constant_name(MaxLinks)]
		fn max_links() -> u32 {
			limits::MAX_LINKS
		}
		#[pallet::constant_name(MaxLinkTitleLen)]
		fn max_link_title_len() -> u32 {
			limits::MAX_LINK_TITLE_LEN
		}
		#[pallet::constant_name(MaxBioLen)]
		fn max_bio_len() -> u32 {
			limits::MAX_BIO_LEN
		}
		#[pallet::constant_name(MaxAvatarLen)]
		fn max_avatar_len() -> u32 {
			limits::MAX_AVATAR_LEN
		}
		#[pallet::constant_name(AvatarSizes)]
		fn avatar_sizes() -> [(u32, u32); 1] {
			limits::AVATAR_SIZES
		}
		#[pallet::constant_name(MaxSecretBlobLen)]
		fn max_secret_blob_len() -> u32 {
			limits::MAX_SECRET_BLOB_LEN
		}
		#[pallet::constant_name(MaxSubs)]
		fn max_subs() -> u32 {
			limits::MAX_SUBS
		}
		#[pallet::constant_name(MaxSubLabelLen)]
		fn max_sub_label_len() -> u32 {
			limits::MAX_SUB_LABEL_LEN
		}
		#[pallet::constant_name(NameMin)]
		fn name_min() -> u32 {
			limits::NAME_MIN
		}
		#[pallet::constant_name(NameMax)]
		fn name_max() -> u32 {
			limits::NAME_MAX
		}
		#[pallet::constant_name(MaxPendingRequests)]
		fn max_pending_requests() -> u32 {
			limits::MAX_PENDING_REQUESTS
		}
		#[pallet::constant_name(MaxNoteLen)]
		fn max_note_len() -> u32 {
			limits::MAX_NOTE_LEN
		}
		#[pallet::constant_name(MaxAuthorities)]
		fn max_authorities() -> u32 {
			limits::MAX_AUTHORITIES
		}
		#[pallet::constant_name(MaxAuthorityNameLen)]
		fn max_authority_name_len() -> u32 {
			limits::MAX_AUTHORITY_NAME_LEN
		}
		#[pallet::constant_name(MaxImportedJudgements)]
		fn max_imported_judgements() -> u32 {
			limits::MAX_IMPORTED_JUDGEMENTS
		}
		#[pallet::constant_name(QuotaPerWindow)]
		fn quota_per_window() -> u32 {
			limits::QUOTA_PER_WINDOW
		}
		#[pallet::constant_name(GlobalFeelessPerBlock)]
		fn global_feeless_per_block() -> u32 {
			limits::GLOBAL_FEELESS_PER_BLOCK
		}
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Set the bio of the caller's identity, creating the identity if needed.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::set_bio())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _bio: &Bio| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn set_bio(origin: OriginFor<T>, bio: Bio) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_set_bio(&who, bio)
		}

		/// Set a typed or custom field, public or private, creating the identity if needed.
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::set_field())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _key: &FieldKey, _value: &FieldValue| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn set_field(origin: OriginFor<T>, key: FieldKey, value: FieldValue) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_set_field(&who, key, value)
		}

		/// Remove a typed or custom field.
		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::clear_field())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _key: &FieldKey| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn clear_field(origin: OriginFor<T>, key: FieldKey) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_clear_field(&who, key)
		}

		/// Append a link, creating the identity if needed.
		#[pallet::call_index(3)]
		#[pallet::weight(T::WeightInfo::add_link())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _title: &LinkTitle, _url: &Value| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn add_link(origin: OriginFor<T>, title: LinkTitle, url: Value) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_add_link(&who, title, url).map(|_| ())
		}

		/// Replace the title and url of a link.
		#[pallet::call_index(4)]
		#[pallet::weight(T::WeightInfo::update_link())]
		#[pallet::feeless_if(
			|origin: &OriginFor<T>, _id: &u32, _title: &LinkTitle, _url: &Value| -> bool {
				Pallet::<T>::user_call_feeless(origin)
			}
		)]
		pub fn update_link(
			origin: OriginFor<T>,
			id: u32,
			title: LinkTitle,
			url: Value,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_update_link(&who, id, title, url)
		}

		/// Remove a link.
		#[pallet::call_index(5)]
		#[pallet::weight(T::WeightInfo::remove_link())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _id: &u32| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn remove_link(origin: OriginFor<T>, id: u32) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_remove_link(&who, id)
		}

		/// Reorder the links: `ids` lists every current link exactly once.
		#[pallet::call_index(6)]
		#[pallet::weight(T::WeightInfo::reorder_links())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _ids: &LinkIds| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn reorder_links(origin: OriginFor<T>, ids: LinkIds) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_reorder_links(&who, ids)
		}

		/// Set the avatar (WebP, 64x64), creating the identity if needed.
		#[pallet::call_index(7)]
		#[pallet::weight(T::WeightInfo::set_avatar())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _bytes: &AvatarBytes| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn set_avatar(origin: OriginFor<T>, bytes: AvatarBytes) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_set_avatar(&who, bytes)
		}

		/// Remove the avatar.
		#[pallet::call_index(8)]
		#[pallet::weight(T::WeightInfo::clear_avatar())]
		#[pallet::feeless_if(|origin: &OriginFor<T>| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn clear_avatar(origin: OriginFor<T>) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_clear_avatar(&who)
		}

		/// Make a private field public by giving the value and salt behind its commitment.
		#[pallet::call_index(9)]
		#[pallet::weight(T::WeightInfo::reveal_field())]
		#[pallet::feeless_if(
			|origin: &OriginFor<T>, _key: &FieldKey, _value: &Value, _salt: &[u8; 32]| -> bool {
				Pallet::<T>::user_call_feeless(origin)
			}
		)]
		pub fn reveal_field(
			origin: OriginFor<T>,
			key: FieldKey,
			value: Value,
			salt: [u8; 32],
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_reveal_field(&who, key, value, salt)
		}

		/// Delete the caller's identity and everything attached to it, except the facts
		/// authorities recorded about the person (a fraud finding cannot be erased this way) and
		/// the identity secret, which belongs to the account. The account itself, its provider
		/// reference and its nonce are kept.
		#[pallet::call_index(10)]
		#[pallet::weight(T::WeightInfo::clear_identity())]
		#[pallet::feeless_if(|origin: &OriginFor<T>| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn clear_identity(origin: OriginFor<T>) -> DispatchResultWithPostInfo {
			// Declares the weight of the fullest identity; reports what it deleted.
			let early = || T::WeightInfo::clear_identity_early();
			let who = ensure_signed(origin).map_err(|e| Self::failed(early(), e))?;
			let cleared = Self::do_clear_identity(&who).map_err(|e| Self::failed(early(), e))?;
			Self::deposit_event(Event::IdentityCleared { who });
			Ok(Self::used(T::WeightInfo::clear_identity_actual(cleared)))
		}

		/// Purge an abusive identity: what `clear_identity` deletes, and the facts about the
		/// person, the migration history and the identity secret too.
		#[pallet::call_index(11)]
		#[pallet::weight(T::WeightInfo::clear_identity())]
		pub fn kill_identity(
			origin: OriginFor<T>,
			who: T::AccountId,
		) -> DispatchResultWithPostInfo {
			let early = || T::WeightInfo::clear_identity_early();
			T::AuthorityOrigin::ensure_origin(origin).map_err(|e| Self::failed(early(), e))?;
			let mut cleared =
				Self::do_clear_identity(&who).map_err(|e| Self::failed(early(), e))?;
			// Unlike the owner's own clear, a purge also deletes the facts about the person and
			// the provenance of a migration.
			cleared.facts = Self::clear_facts(&who);
			ImportedHistory::<T>::remove(&who);
			cleared.history = true;
			IdentitySecrets::<T>::remove(&who);
			cleared.secret = true;
			Self::deposit_event(Event::IdentityPurged { who });
			Ok(Self::used(T::WeightInfo::clear_identity_actual(cleared)))
		}

		/// Set and clear several fields in one call, in order: `Some(value)` does what
		/// `set_field` does, `None` what `clear_field` does. All or nothing, and the same field
		/// cannot appear twice.
		#[pallet::call_index(12)]
		#[pallet::weight(T::WeightInfo::set_identity())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _changes: &FieldChanges| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn set_identity(
			origin: OriginFor<T>,
			changes: FieldChanges,
		) -> DispatchResultWithPostInfo {
			// Declares the weight of the fullest call; reports the changes it started.
			let who = ensure_signed(origin)
				.map_err(|e| Self::failed(T::WeightInfo::set_identity_actual(0), e))?;
			Self::do_set_identity(&who, changes)
		}

		/// Store the encrypted identity secret of the caller, replacing the one it had. The chain
		/// keeps the bytes as they are, 1 to 256 of them, and needs no identity.
		#[pallet::call_index(13)]
		#[pallet::weight(T::WeightInfo::set_identity_secret())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _blob: &SecretBlob| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn set_identity_secret(origin: OriginFor<T>, blob: SecretBlob) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_set_identity_secret(&who, blob)
		}

		/// Delete the encrypted identity secret of the caller. Succeeds when there is none.
		#[pallet::call_index(14)]
		#[pallet::weight(T::WeightInfo::clear_identity_secret())]
		#[pallet::feeless_if(|origin: &OriginFor<T>| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn clear_identity_secret(origin: OriginFor<T>) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_clear_identity_secret(&who);
			Ok(())
		}

		/// Set or change the whole profile in one call: the identity secret, the bio, the avatar,
		/// fields and links, in that order, each part as its single call does it
		/// (`set_identity_secret`, `set_bio`, `set_avatar` or `clear_avatar`, `set_identity`, and
		/// the link calls). `None` keeps a part as it is; `links` gives the whole list, see
		/// [`ProfileUpdate`]. All or nothing, and an update that changes nothing is refused.
		#[pallet::call_index(15)]
		#[pallet::weight(T::WeightInfo::update_profile())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _update: &ProfileUpdate| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn update_profile(
			origin: OriginFor<T>,
			update: ProfileUpdate,
		) -> DispatchResultWithPostInfo {
			// Declares the weight of the fullest update; reports the steps it started.
			let who = ensure_signed(origin).map_err(|e| {
				Self::failed(T::WeightInfo::update_profile_actual(Default::default()), e)
			})?;
			Self::do_update_profile(&who, update)
		}

		/// Register a new identity authority, active, under the next id.
		#[pallet::call_index(20)]
		#[pallet::weight(T::WeightInfo::add_authority())]
		pub fn add_authority(origin: OriginFor<T>, name: AuthorityName) -> DispatchResult {
			T::AuthorityOrigin::ensure_origin(origin)?;
			Self::do_add_authority(name).map(|_| ())
		}

		/// Make `agent` an agent of `authority` holding the capabilities `caps` (see
		/// [`Capabilities`]: 1 attest fields, 2 person facts, 4 manage names, 8 migrate), or
		/// change the capabilities it holds there. An account serves one authority only.
		#[pallet::call_index(21)]
		#[pallet::weight(T::WeightInfo::set_agent())]
		pub fn set_agent(
			origin: OriginFor<T>,
			authority: AuthorityId,
			agent: T::AccountId,
			caps: u8,
		) -> DispatchResult {
			T::AuthorityOrigin::ensure_origin(origin)?;
			Self::do_set_agent(authority, agent, caps)
		}

		/// Remove an agent.
		#[pallet::call_index(22)]
		#[pallet::weight(T::WeightInfo::remove_agent())]
		pub fn remove_agent(origin: OriginFor<T>, agent: T::AccountId) -> DispatchResult {
			T::AuthorityOrigin::ensure_origin(origin)?;
			Self::do_remove_agent(agent)
		}

		/// Activate or deactivate an authority; while inactive, its agents cannot act.
		#[pallet::call_index(23)]
		#[pallet::weight(T::WeightInfo::set_authority_active())]
		pub fn set_authority_active(
			origin: OriginFor<T>,
			authority: AuthorityId,
			active: bool,
		) -> DispatchResult {
			T::AuthorityOrigin::ensure_origin(origin)?;
			Self::do_set_authority_active(authority, active)
		}

		/// Ask `authority` to check a field of the caller's identity or to record a fact about
		/// them. At most `MaxPendingRequests` pending requests per account.
		#[pallet::call_index(30)]
		#[pallet::weight(T::WeightInfo::request_judgement())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _authority: &AuthorityId, _target: &Target| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn request_judgement(
			origin: OriginFor<T>,
			authority: AuthorityId,
			target: Target,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_request_judgement(&who, authority, target)
		}

		/// Withdraw a pending request.
		#[pallet::call_index(31)]
		#[pallet::weight(T::WeightInfo::cancel_request())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _authority: &AuthorityId, _target: &Target| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn cancel_request(
			origin: OriginFor<T>,
			authority: AuthorityId,
			target: Target,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_cancel_request(&who, authority, target)
		}

		/// Agent (attest fields): record the authority's verdict on field `key` of `who`,
		/// checked against the value whose commitment is `expected_commitment` (see
		/// [`crate::types::commitment`] and [`crate::types::link_commitment`]). Replaces the
		/// authority's previous attestation of that field and consumes the matching request.
		#[pallet::call_index(32)]
		#[pallet::weight(T::WeightInfo::provide_judgement())]
		#[pallet::feeless_if(
			|origin: &OriginFor<T>, _who: &T::AccountId, _key: &FieldKey, _expected: &H256,
			 _verdict: &Verdict, _method: &Method, _expires_at: &Option<BlockNumberFor<T>>| -> bool {
				Pallet::<T>::agent_call_feeless(origin, Capabilities::ATTEST_FIELDS)
			}
		)]
		pub fn provide_judgement(
			origin: OriginFor<T>,
			who: T::AccountId,
			key: FieldKey,
			expected_commitment: H256,
			verdict: Verdict,
			method: Method,
			expires_at: Option<BlockNumberFor<T>>,
		) -> DispatchResult {
			let agent = ensure_signed(origin)?;
			Self::do_provide_judgement(
				&agent,
				who,
				key,
				expected_commitment,
				verdict,
				method,
				expires_at,
			)
		}

		/// Agent (attest fields): revoke the authority's attestation of field `key` of `who`.
		#[pallet::call_index(33)]
		#[pallet::weight(T::WeightInfo::revoke_attestation())]
		#[pallet::feeless_if(
			|origin: &OriginFor<T>, _who: &T::AccountId, _key: &FieldKey, _reason: &ReasonCode| -> bool {
				Pallet::<T>::agent_call_feeless(origin, Capabilities::ATTEST_FIELDS)
			}
		)]
		pub fn revoke_attestation(
			origin: OriginFor<T>,
			who: T::AccountId,
			key: FieldKey,
			reason: ReasonCode,
		) -> DispatchResult {
			let agent = ensure_signed(origin)?;
			Self::do_revoke_attestation(&agent, who, key, reason)
		}

		/// Agent: refuse a request made to the authority, with a reason and a short note. A
		/// field request needs the attest fields capability, a fact request the person facts one.
		#[pallet::call_index(34)]
		#[pallet::weight(T::WeightInfo::reject_request())]
		#[pallet::feeless_if(
			|origin: &OriginFor<T>, _who: &T::AccountId, target: &Target, _reason: &ReasonCode,
			 _note: &Note| -> bool {
				Pallet::<T>::agent_call_feeless(origin, Pallet::<T>::target_capability(target))
			}
		)]
		pub fn reject_request(
			origin: OriginFor<T>,
			who: T::AccountId,
			target: Target,
			reason: ReasonCode,
			note: Note,
		) -> DispatchResult {
			let agent = ensure_signed(origin)?;
			Self::do_reject_request(&agent, who, target, reason, note)
		}

		/// Agent (person facts): record a fact about the person behind the identity of `who`.
		/// Replaces the authority's previous fact of that kind and consumes the matching request.
		#[pallet::call_index(35)]
		#[pallet::weight(T::WeightInfo::grant_fact())]
		#[pallet::feeless_if(
			|origin: &OriginFor<T>, _who: &T::AccountId, _kind: &FactKind,
			 _expires_at: &Option<BlockNumberFor<T>>, _reason: &ReasonCode, _note: &Note| -> bool {
				Pallet::<T>::agent_call_feeless(origin, Capabilities::PERSON_FACTS)
			}
		)]
		pub fn grant_fact(
			origin: OriginFor<T>,
			who: T::AccountId,
			kind: FactKind,
			expires_at: Option<BlockNumberFor<T>>,
			reason: ReasonCode,
			note: Note,
		) -> DispatchResult {
			let agent = ensure_signed(origin)?;
			Self::do_grant_fact(&agent, who, kind, expires_at, reason, note)
		}

		/// Agent (person facts): revoke a fact the authority recorded.
		#[pallet::call_index(36)]
		#[pallet::weight(T::WeightInfo::revoke_fact())]
		#[pallet::feeless_if(
			|origin: &OriginFor<T>, _who: &T::AccountId, _kind: &FactKind, _reason: &ReasonCode| -> bool {
				Pallet::<T>::agent_call_feeless(origin, Capabilities::PERSON_FACTS)
			}
		)]
		pub fn revoke_fact(
			origin: OriginFor<T>,
			who: T::AccountId,
			kind: FactKind,
			reason: ReasonCode,
		) -> DispatchResult {
			let agent = ensure_signed(origin)?;
			Self::do_revoke_fact(&agent, who, kind, reason)
		}

		/// Claim `name` for the caller. Needs an identity with a field that has a valid verified
		/// attestation (and no valid rejection), no name yet, and a name that is valid, free,
		/// not reserved and out of quarantine, and no active `Fraud` fact from any authority.
		/// The name is then kept even if the attestation stops being valid.
		#[pallet::call_index(40)]
		#[pallet::weight(T::WeightInfo::claim_username())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _name: &Name| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn claim_username(origin: OriginFor<T>, name: Name) -> DispatchResultWithPostInfo {
			// Declares the weight of the fullest identity; reports what it did.
			let who = ensure_signed(origin)
				.map_err(|e| Self::failed(T::WeightInfo::claim_username_early(), e))?;
			Self::do_claim_username(&who, name)
		}

		/// Give up the caller's name. It cannot be claimed again by anyone for `NameQuarantine`,
		/// and the caller cannot claim any name for one quota window.
		#[pallet::call_index(41)]
		#[pallet::weight(T::WeightInfo::release_username())]
		#[pallet::feeless_if(|origin: &OriginFor<T>| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn release_username(origin: OriginFor<T>) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_release_username(&who)
		}

		/// Manager (Root, or an agent holding manage names): reserve `name`, so that nobody can
		/// claim it and only a manager can assign it.
		#[pallet::call_index(42)]
		#[pallet::weight(T::WeightInfo::reserve_username())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _name: &Name| -> bool {
			Pallet::<T>::agent_call_feeless(origin, Capabilities::MANAGE_NAMES)
		})]
		pub fn reserve_username(origin: OriginFor<T>, name: Name) -> DispatchResult {
			Self::ensure_names_manager(origin)?;
			Self::do_reserve_username(name)
		}

		/// Manager (Root, or an agent holding manage names): lift the reservation of `name`.
		#[pallet::call_index(43)]
		#[pallet::weight(T::WeightInfo::unreserve_username())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _name: &Name| -> bool {
			Pallet::<T>::agent_call_feeless(origin, Capabilities::MANAGE_NAMES)
		})]
		pub fn unreserve_username(origin: OriginFor<T>, name: Name) -> DispatchResult {
			Self::ensure_names_manager(origin)?;
			Self::do_unreserve_username(name)
		}

		/// Manager (Root, or an agent holding manage names): give `name` to `who`, which needs an
		/// identity and no name. Goes past the reservation (which it consumes), the attestation
		/// requirement and the claim cooldown, not the quarantine.
		#[pallet::call_index(44)]
		#[pallet::weight(T::WeightInfo::set_username_for())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _who: &T::AccountId, _name: &Name| -> bool {
			Pallet::<T>::agent_call_feeless(origin, Capabilities::MANAGE_NAMES)
		})]
		pub fn set_username_for(
			origin: OriginFor<T>,
			who: T::AccountId,
			name: Name,
		) -> DispatchResult {
			Self::ensure_names_manager(origin)?;
			Self::do_set_username_for(who, name)
		}

		/// Manager (Root, or an agent holding manage names): take the name away from `who`, with a
		/// reason. It goes into quarantine; the account may claim another name at once.
		#[pallet::call_index(45)]
		#[pallet::weight(T::WeightInfo::unbind_username())]
		#[pallet::feeless_if(
			|origin: &OriginFor<T>, _who: &T::AccountId, _reason: &ReasonCode| -> bool {
				Pallet::<T>::agent_call_feeless(origin, Capabilities::MANAGE_NAMES)
			}
		)]
		pub fn unbind_username(
			origin: OriginFor<T>,
			who: T::AccountId,
			reason: ReasonCode,
		) -> DispatchResult {
			Self::ensure_names_manager(origin)?;
			Self::do_unbind_username(who, reason)
		}

		/// Propose `sub` as a sub-account of the caller, which needs an identity and must not be a
		/// sub-account itself. `sub` is linked once it accepts; it needs no identity, and several
		/// parents can propose the same account. At most `MaxSubs` subs and proposals per parent.
		#[pallet::call_index(50)]
		#[pallet::weight(T::WeightInfo::add_sub())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _sub: &T::AccountId, _label: &SubLabel| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn add_sub(origin: OriginFor<T>, sub: T::AccountId, label: SubLabel) -> DispatchResult {
			let parent = ensure_signed(origin)?;
			Self::do_add_sub(&parent, sub, label)
		}

		/// Accept the proposal `parent` made to the caller: the caller is now a member of `parent`.
		/// Refused if the caller has a parent already or accepted subs, or if `parent` is itself a
		/// sub-account. The caller's other proposals stay as they are.
		#[pallet::call_index(51)]
		#[pallet::weight(T::WeightInfo::accept_sub())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _parent: &T::AccountId| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn accept_sub(
			origin: OriginFor<T>,
			parent: T::AccountId,
		) -> DispatchResultWithPostInfo {
			// Declares the weight of the fullest list of subs; reports what it read.
			let early = || T::WeightInfo::accept_sub_actual(0);
			let sub = ensure_signed(origin).map_err(|e| Self::failed(early(), e))?;
			Self::do_accept_sub(&sub, parent)
		}

		/// End the link with `sub`, accepted or still a proposal.
		#[pallet::call_index(52)]
		#[pallet::weight(T::WeightInfo::remove_sub())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _sub: &T::AccountId| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn remove_sub(origin: OriginFor<T>, sub: T::AccountId) -> DispatchResult {
			let parent = ensure_signed(origin)?;
			Self::do_remove_sub(&parent, sub)
		}

		/// End the caller's link with its parent.
		#[pallet::call_index(53)]
		#[pallet::weight(T::WeightInfo::quit_sub())]
		#[pallet::feeless_if(|origin: &OriginFor<T>| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn quit_sub(origin: OriginFor<T>) -> DispatchResult {
			let sub = ensure_signed(origin)?;
			Self::do_quit_sub(&sub)
		}

		/// Change the label of `sub`, accepted or still a proposal. The consent is not affected.
		#[pallet::call_index(54)]
		#[pallet::weight(T::WeightInfo::rename_sub())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _sub: &T::AccountId, _label: &SubLabel| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn rename_sub(
			origin: OriginFor<T>,
			sub: T::AccountId,
			label: SubLabel,
		) -> DispatchResult {
			let parent = ensure_signed(origin)?;
			Self::do_rename_sub(&parent, sub, label)
		}

		/// Refuse the proposal `parent` made to the caller. An accepted link ends with
		/// `quit_sub` instead.
		#[pallet::call_index(55)]
		#[pallet::weight(T::WeightInfo::decline_sub())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _parent: &T::AccountId| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn decline_sub(origin: OriginFor<T>, parent: T::AccountId) -> DispatchResult {
			let sub = ensure_signed(origin)?;
			Self::do_decline_sub(&sub, parent)
		}

		/// Ask for the migration of the caller's identity from the People Chain `source`. The
		/// caller must have no identity, no pending request, and never have migrated.
		#[pallet::call_index(60)]
		#[pallet::weight(T::WeightInfo::request_migration())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, _source: &SourceChain| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn request_migration(origin: OriginFor<T>, source: SourceChain) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_request_migration(&who, source)
		}

		/// Withdraw the caller's migration request.
		#[pallet::call_index(61)]
		#[pallet::weight(T::WeightInfo::cancel_migration())]
		#[pallet::feeless_if(|origin: &OriginFor<T>| -> bool {
			Pallet::<T>::user_call_feeless(origin)
		})]
		pub fn cancel_migration(origin: OriginFor<T>) -> DispatchResult {
			let who = ensure_signed(origin)?;
			Self::do_cancel_migration(&who)
		}

		/// Agent (migrate): create the identity of `who` from `payload`, read on `source` at
		/// block `block` whose hash is `block_hash`, and map its dotID judgement to attestations
		/// and facts of the agent's authority (see `migration.rs`). Needs a pending request of
		/// `who` for `source`, which it consumes, and no identity. Refuses the whole payload if
		/// any entry is invalid.
		#[pallet::call_index(62)]
		#[pallet::weight(T::WeightInfo::fulfil_migration())]
		#[pallet::feeless_if(
			|origin: &OriginFor<T>, _who: &T::AccountId, _source: &SourceChain, _block: &u32,
			 _block_hash: &H256, _payload: &MigrationPayload| -> bool {
				Pallet::<T>::agent_call_feeless(origin, Capabilities::MIGRATE)
			}
		)]
		pub fn fulfil_migration(
			origin: OriginFor<T>,
			who: T::AccountId,
			source: SourceChain,
			block: u32,
			block_hash: H256,
			payload: MigrationPayload,
		) -> DispatchResultWithPostInfo {
			// Declares every field attested and a fact; reports what it wrote.
			let agent = ensure_signed(origin)?;
			let imported =
				Self::do_fulfil_migration(&agent, who, source, block, block_hash, payload)?;
			Ok(Self::used(T::WeightInfo::fulfil_migration_actual(imported)))
		}

		/// Agent (migrate): refuse the migration request of `who`, with a reason.
		#[pallet::call_index(63)]
		#[pallet::weight(T::WeightInfo::reject_migration())]
		#[pallet::feeless_if(
			|origin: &OriginFor<T>, _who: &T::AccountId, _reason: &ReasonCode| -> bool {
				Pallet::<T>::agent_call_feeless(origin, Capabilities::MIGRATE)
			}
		)]
		pub fn reject_migration(
			origin: OriginFor<T>,
			who: T::AccountId,
			reason: ReasonCode,
		) -> DispatchResult {
			let agent = ensure_signed(origin)?;
			Self::do_reject_migration(&agent, who, reason)
		}
	}

	impl<T: Config> Pallet<T> {
		/// A call that succeeded having used `weight`.
		pub(crate) fn used(weight: Weight) -> PostDispatchInfo {
			Some(weight).into()
		}

		/// A call that failed with `error` having used `weight`.
		pub(crate) fn failed(
			weight: Weight,
			error: impl Into<DispatchError>,
		) -> DispatchErrorWithPostInfo {
			DispatchErrorWithPostInfo { post_info: Self::used(weight), error: error.into() }
		}

		/// Record that `who` was given a provider reference by a feeless onboarding.
		///
		/// Called by the runtime's `CheckNonceOnboard` extension right after
		/// `frame_system::Pallet::inc_providers`. The entry records which provider references the
		/// chain handed out; nothing releases them, so the account and its nonce outlive a cleared
		/// identity.
		pub fn note_onboarded(who: &T::AccountId) {
			ProviderHeld::<T>::insert(who, ());
		}
	}
}
