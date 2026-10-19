use crate::{Error, Result};

const INITIAL_HASH: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn calculate_partial_hash(data: &[u8]) -> [u8; 32] {
    let words = padded_words(data, data.len() * 8);
    let mut hash = INITIAL_HASH;
    for chunk_start in (0..words.len()).step_by(16) {
        if chunk_start == words.len() - 16 {
            return hash_to_bytes(hash);
        }
        compress_chunk(&words[chunk_start..chunk_start + 16], &mut hash);
    }
    hash_to_bytes(hash)
}

pub fn partial_hash(data: &[u8], initial_hash: &[u8], complete_size_le: &[u8]) -> Result<[u8; 32]> {
    if complete_size_le.is_empty() {
        return Err(Error::InvalidScript(
            "partial sha256 complete size is empty".to_string(),
        ));
    }
    let complete_size_bytes = complete_size_le
        .iter()
        .enumerate()
        .try_fold(0usize, |sum, (index, byte)| {
            sum.checked_add((*byte as usize) << (8 * index))
        })
        .ok_or_else(|| Error::InvalidScript("partial sha256 size overflow".to_string()))?;
    let mut hash = if initial_hash.is_empty() {
        INITIAL_HASH
    } else {
        if initial_hash.len() != 32 {
            return Err(Error::InvalidScript(
                "partial sha256 initial hash must be 32 bytes".to_string(),
            ));
        }
        bytes_to_hash(initial_hash)
    };
    let words = padded_words(data, complete_size_bytes * 8);
    for chunk_start in (0..words.len()).step_by(16) {
        compress_chunk(&words[chunk_start..chunk_start + 16], &mut hash);
    }
    Ok(hash_to_bytes(hash))
}

fn padded_words(data: &[u8], complete_size_bits: usize) -> Vec<u32> {
    let remain_bits = data.len() * 8;
    let length_index = (((remain_bits + 64) >> 9) << 4) + 15;
    let mut words = vec![0u32; length_index + 1];
    for (index, byte) in data.iter().enumerate() {
        words[index >> 2] |= (*byte as u32) << (24 - ((index * 8) % 32));
    }
    words[remain_bits >> 5] |= 0x80 << (24 - (remain_bits % 32));
    words[length_index] = complete_size_bits as u32;
    words
}

fn compress_chunk(chunk: &[u32], hash: &mut [u32; 8]) {
    let mut w = [0u32; 64];
    w[..16].copy_from_slice(chunk);
    for index in 16..64 {
        w[index] = small_sigma1(w[index - 2])
            .wrapping_add(w[index - 7])
            .wrapping_add(small_sigma0(w[index - 15]))
            .wrapping_add(w[index - 16]);
    }

    let mut a = hash[0];
    let mut b = hash[1];
    let mut c = hash[2];
    let mut d = hash[3];
    let mut e = hash[4];
    let mut f = hash[5];
    let mut g = hash[6];
    let mut h = hash[7];

    for index in 0..64 {
        let t1 = h
            .wrapping_add(big_sigma1(e))
            .wrapping_add((e & f) ^ ((!e) & g))
            .wrapping_add(K[index])
            .wrapping_add(w[index]);
        let t2 = big_sigma0(a).wrapping_add((a & b) ^ (a & c) ^ (b & c));
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }

    hash[0] = hash[0].wrapping_add(a);
    hash[1] = hash[1].wrapping_add(b);
    hash[2] = hash[2].wrapping_add(c);
    hash[3] = hash[3].wrapping_add(d);
    hash[4] = hash[4].wrapping_add(e);
    hash[5] = hash[5].wrapping_add(f);
    hash[6] = hash[6].wrapping_add(g);
    hash[7] = hash[7].wrapping_add(h);
}

fn big_sigma0(value: u32) -> u32 {
    value.rotate_right(2) ^ value.rotate_right(13) ^ value.rotate_right(22)
}

fn big_sigma1(value: u32) -> u32 {
    value.rotate_right(6) ^ value.rotate_right(11) ^ value.rotate_right(25)
}

fn small_sigma0(value: u32) -> u32 {
    value.rotate_right(7) ^ value.rotate_right(18) ^ (value >> 3)
}

fn small_sigma1(value: u32) -> u32 {
    value.rotate_right(17) ^ value.rotate_right(19) ^ (value >> 10)
}

fn hash_to_bytes(hash: [u32; 8]) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    for (index, word) in hash.iter().enumerate() {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    bytes
}

fn bytes_to_hash(bytes: &[u8]) -> [u32; 8] {
    let mut hash = [0u32; 8];
    for (index, chunk) in bytes.chunks_exact(4).enumerate() {
        let mut raw = [0u8; 4];
        raw.copy_from_slice(chunk);
        hash[index] = u32::from_be_bytes(raw);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ft_partial_sha256_matches_js_for_short_and_long_buffers() {
        let short = vec![0u8; 32];
        assert_eq!(
            hex::encode(calculate_partial_hash(&short)),
            "6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19"
        );

        let long = (0u8..=159).collect::<Vec<_>>();
        assert_eq!(
            hex::encode(calculate_partial_hash(&long)),
            "593253adfb4cc018be611395485e47c15a5b271dfb8da14fe8f77fb4d05eacbc"
        );
    }
}
