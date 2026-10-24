//! Size and count limits of the identitee pallet.
//!
//! Every limit is a plain Rust constant so that pure validators can use it without FRAME. The
//! limits a client checks against are exposed in the metadata through `#[pallet::extra_constants]`,
//! so clients read the same values as the runtime. Durations (quota window, name quarantine) are
//! `Config` constants, block counts that the runtime derives from its block time.

/// Maximum length of a single field value, in bytes.
pub const MAX_VALUE_LEN: u32 = 256;
/// Maximum length of a custom field key, in bytes.
pub const MAX_CUSTOM_KEY_LEN: u32 = 32;
/// Bound of the number of typed fields per identity (above the number of field kinds).
pub const MAX_TYPED_FIELDS: u32 = 16;
/// Maximum number of custom fields per identity.
pub const MAX_CUSTOM_FIELDS: u32 = 16;
/// Maximum number of links per identity.
pub const MAX_LINKS: u32 = 16;
/// Maximum length of a link title, in bytes.
pub const MAX_LINK_TITLE_LEN: u32 = 64;
/// Maximum length of the bio, in UTF-8 bytes.
pub const MAX_BIO_LEN: u32 = 560;
/// Maximum size of the avatar image, in bytes.
pub const MAX_AVATAR_LEN: u32 = 8192;
/// Accepted avatar dimensions (width, height), in pixels.
pub const AVATAR_SIZES: [(u32, u32); 1] = [(64, 64)];
/// Maximum size of the encrypted identity secret the chain stores for an account, in bytes.
pub const MAX_SECRET_BLOB_LEN: u32 = 256;
/// Maximum number of changes in one `set_identity` call.
pub const MAX_FIELD_CHANGES: u32 = 32;
/// Maximum number of sub-accounts per identity.
pub const MAX_SUBS: u32 = 100;
/// Maximum length of a sub-account label, in bytes.
pub const MAX_SUB_LABEL_LEN: u32 = 64;
/// Minimum length of a name.
pub const NAME_MIN: u32 = 3;
/// Maximum length of a name.
pub const NAME_MAX: u32 = 32;
/// Maximum number of pending judgement requests per identity.
pub const MAX_PENDING_REQUESTS: u32 = 16;
/// Maximum length of a note attached to a fact or a refusal, in bytes.
pub const MAX_NOTE_LEN: u32 = 128;
/// Maximum number of identity authorities ever registered (ids are not reused). Bounds the
/// attestations of a field and of an identity.
pub const MAX_AUTHORITIES: u32 = 16;
/// Maximum number of fields an identity can have: typed, custom and links.
pub const MAX_FIELDS_PER_IDENTITY: u32 = MAX_TYPED_FIELDS + MAX_CUSTOM_FIELDS + MAX_LINKS;
/// Maximum number of field attestations an identity can have: one per present field and
/// authority. Attestations go with their field when it is removed.
pub const MAX_ATTESTATIONS_PER_IDENTITY: u32 = MAX_FIELDS_PER_IDENTITY * MAX_AUTHORITIES;
/// Maximum length of an authority name, in bytes.
pub const MAX_AUTHORITY_NAME_LEN: u32 = 64;
/// Maximum number of judgements imported by a migration.
pub const MAX_IMPORTED_JUDGEMENTS: u32 = 32;
/// Number of feeless calls an account may make per quota window.
pub const QUOTA_PER_WINDOW: u32 = 50;
/// Number of feeless calls accepted per block, all accounts together.
pub const GLOBAL_FEELESS_PER_BLOCK: u32 = 20;
