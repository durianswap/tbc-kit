pub fn compact_size(value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    write_compact_size(value, &mut out);
    out
}

pub fn write_compact_size(value: u64, out: &mut Vec<u8>) {
    match value {
        0..=252 => out.push(value as u8),
        253..=0xffff => {
            out.push(0xfd);
            out.extend_from_slice(&(value as u16).to_le_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(0xfe);
            out.extend_from_slice(&(value as u32).to_le_bytes());
        }
        _ => {
            out.push(0xff);
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
}

pub fn read_compact_size(bytes: &[u8], offset: &mut usize) -> crate::Result<u64> {
    let first = *bytes
        .get(*offset)
        .ok_or(crate::Error::InvalidTransactionHex)?;
    *offset += 1;
    match first {
        0xfd => {
            let raw = read_exact::<2>(bytes, offset)?;
            Ok(u16::from_le_bytes(raw) as u64)
        }
        0xfe => {
            let raw = read_exact::<4>(bytes, offset)?;
            Ok(u32::from_le_bytes(raw) as u64)
        }
        0xff => {
            let raw = read_exact::<8>(bytes, offset)?;
            Ok(u64::from_le_bytes(raw))
        }
        value => Ok(value as u64),
    }
}

pub fn read_exact<const N: usize>(bytes: &[u8], offset: &mut usize) -> crate::Result<[u8; N]> {
    let end = offset
        .checked_add(N)
        .ok_or(crate::Error::InvalidTransactionHex)?;
    let slice = bytes
        .get(*offset..end)
        .ok_or(crate::Error::InvalidTransactionHex)?;
    *offset = end;
    Ok(slice.try_into().expect("slice length checked"))
}

#[cfg(test)]
mod primitive_tests {
    #[test]
    fn primitive_compact_size_encodes_boundaries() {
        assert_eq!(crate::encoding::compact_size(252), vec![252]);
        assert_eq!(crate::encoding::compact_size(253), vec![0xfd, 253, 0]);
    }
}
