//! Bounded, process-local wallet-private handle registry. Handles confer no
//! approval authority. The trusted platform checks permission/approval and
//! supplies monotonic milliseconds; revoked/navigation contexts call cancel_all.
use super::{Error, Group, SignerSession};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zeroize::{Zeroize, Zeroizing};

pub type Handle = [u8; 32];
pub const MAX_SESSIONS: usize = 32;
pub const MAX_TTL_MS: u64 = 300_000;

struct Entry {
    session: SignerSession,
    created: u64,
    expires: u64,
}

/// No serialization or Clone: restart cannot restore or copy secret sessions.
#[derive(Default)]
pub struct Registry {
    entries: BTreeMap<Handle, Entry>,
    generation: u64,
}

impl Registry {
    pub fn begin(
        &mut self, group: Group, digest: [u8; 32], binding: [u8; 32],
        scalar: &[u8; 32], entropy: &mut [u8; 32], now: u64, expires: u64,
    ) -> Result<(Handle, [u8; 66]), Error> {
        // Also erase entropy on expiry/capacity failure, before nonce generation.
        let mut fresh = Zeroizing::new(*entropy);
        entropy.zeroize();
        self.purge(now);
        if expires <= now || expires - now > MAX_TTL_MS { return Err(Error::Expired); }
        if self.entries.len() >= MAX_SESSIONS { return Err(Error::Capacity); }
        self.generation = self.generation.checked_add(1).ok_or(Error::Capacity)?;
        let session = SignerSession::begin(group, digest, binding, scalar, &mut fresh)?;
        let public = session.public_nonce();
        let mut hash = Sha256::new();
        hash.update(b"TBC wallet-private MuSig handle\0");
        hash.update(self.generation.to_be_bytes());
        hash.update(binding); hash.update(digest); hash.update(public);
        let handle: Handle = hash.finalize().into();
        if self.entries.contains_key(&handle) { return Err(Error::Capacity); }
        self.entries.insert(handle, Entry {session, created: now, expires});
        Ok((handle, public))
    }

    /// Removal happens before all checks. No retry can recover the nonce,
    /// including after expiry, clock rollback or bad external transcript.
    pub fn sign_once(
        &mut self, handle: Handle, binding: [u8; 32], digest: [u8; 32],
        scalar: &[u8; 32], nonces: &[[u8; 66]], now: u64,
    ) -> Result<[u8; 32], Error> {
        let mut entry = self.entries.remove(&handle).ok_or(Error::Consumed)?;
        self.purge(now);
        if now < entry.created || now >= entry.expires { return Err(Error::Expired); }
        entry.session.sign_once(binding, digest, scalar, nonces)
    }

    pub fn cancel(&mut self, handle: Handle) { self.entries.remove(&handle); }
    pub fn cancel_all(&mut self) { self.entries.clear(); }
    pub fn purge(&mut self, now: u64) {
        // A rollback invalidates sessions too; no extension of approval lifetime.
        self.entries.retain(|_, e| now >= e.created && now < e.expires);
    }
    pub fn active_count(&self) -> usize { self.entries.len() }
}
