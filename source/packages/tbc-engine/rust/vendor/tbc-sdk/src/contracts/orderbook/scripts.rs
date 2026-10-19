use crate::{Address, Error, Result, hash, script::Script};

use super::OrderData;

pub const SELL_ORDER_SCRIPT_SIZE: usize = 946;
pub const BUY_ORDER_SCRIPT_SIZE: usize = 1074;
pub const ORDER_DATA_SIZE: usize = 114;
pub const BUY_ORDER_DUST: u64 = 300;

const SELL_PREFIX_SIZE: usize = 832;
const BUY_PREFIX_SIZE: usize = 960;
const FT_CODE_SIZE: usize = 1_884;
const COIN_CODE_SIZE: usize = 2_012;

pub fn sell_order_script(data: &OrderData, is_coin: bool, tax_address: &Address) -> Result<Script> {
    sell_order_script_with_ft_size(
        data,
        if is_coin {
            COIN_CODE_SIZE
        } else {
            FT_CODE_SIZE
        },
        tax_address,
    )
}

pub fn sell_order_script_with_ft_size(
    data: &OrderData,
    ft_code_size: usize,
    tax_address: &Address,
) -> Result<Script> {
    order_script(
        sell_order_prefix_hex(ft_code_size, &data.hold_address, tax_address)?,
        SELL_PREFIX_SIZE,
        data,
    )
}

pub fn buy_order_script(data: &OrderData, is_coin: bool, tax_address: &Address) -> Result<Script> {
    buy_order_script_with_ft_size(
        data,
        if is_coin {
            COIN_CODE_SIZE
        } else {
            FT_CODE_SIZE
        },
        tax_address,
    )
}

pub fn buy_order_script_with_ft_size(
    data: &OrderData,
    ft_code_size: usize,
    tax_address: &Address,
) -> Result<Script> {
    order_script(
        buy_order_prefix_hex(ft_code_size, &data.hold_address, tax_address)?,
        BUY_PREFIX_SIZE,
        data,
    )
}

pub fn order_hash160(script: &Script) -> [u8; 20] {
    hash::hash160(&hash::sha256(script.as_bytes()))
}

pub fn encode_order_data(data: &OrderData) -> Vec<u8> {
    let mut out = Vec::with_capacity(ORDER_DATA_SIZE);
    push_field(&mut out, &data.hold_address.hash160());
    push_field(&mut out, &data.sale_volume.to_le_bytes());
    push_field(&mut out, &data.ft_partial_hash);
    push_field(&mut out, &data.fee_rate.to_le_bytes());
    push_field(&mut out, &data.unit_price.to_le_bytes());
    push_field(&mut out, &data.ft_contract_id);
    out
}

pub fn decode_order_data(script: &Script) -> Result<OrderData> {
    let bytes = script.as_bytes();
    if bytes.len() < ORDER_DATA_SIZE {
        return Err(Error::InvalidScript(
            "order script is shorter than order data".to_string(),
        ));
    }
    decode_order_data_bytes(&bytes[bytes.len() - ORDER_DATA_SIZE..])
}

pub fn update_sale_volume(script: &Script, sale_volume: u64) -> Result<Script> {
    let mut bytes = script.as_bytes().to_vec();
    if bytes.len() < ORDER_DATA_SIZE {
        return Err(Error::InvalidScript(
            "order script is shorter than order data".to_string(),
        ));
    }
    let sale_start = bytes.len() - ORDER_DATA_SIZE + 22;
    bytes[sale_start..sale_start + 8].copy_from_slice(&sale_volume.to_le_bytes());
    Ok(Script::from_bytes(bytes))
}

fn order_script(prefix_hex: String, prefix_size: usize, data: &OrderData) -> Result<Script> {
    let mut bytes = hex::decode(prefix_hex)?;
    if bytes.len() != prefix_size {
        return Err(Error::InvalidScript(format!(
            "order prefix length mismatch: expected {prefix_size}, got {}",
            bytes.len()
        )));
    }
    bytes.extend_from_slice(&encode_order_data(data));
    Ok(Script::from_bytes(bytes))
}

fn push_hex_hash160(out: &mut String, address: &Address) {
    out.push_str("14");
    out.push_str(&hex::encode(address.hash160()));
}

fn ft_code_size_hex(size: usize) -> Result<String> {
    let size = u16::try_from(size)
        .map_err(|_| Error::InvalidScript("FT code size exceeds uint16".to_string()))?;
    Ok(hex::encode(size.to_le_bytes()))
}

fn sell_order_prefix_hex(
    ft_code_size: usize,
    hold_address: &Address,
    tax_address: &Address,
) -> Result<String> {
    let mut prefix = String::new();
    let ft_code_size = ft_code_size_hex(ft_code_size)?;
    let mut hold_address_hex = String::new();
    push_hex_hash160(&mut hold_address_hex, hold_address);
    let mut tax_address_hex = String::new();
    push_hex_hash160(&mut tax_address_hex, tax_address);
    prefix.push_str("765187637556ba01207f77547f75817654958f01289351947901157f597f7701217f597f597f517f7701207f756b517f77816b517f77816b517f776b517f776b7654958f01289379816b7654958f0128935394796b54958f0127935294796b006b7600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575686ca87e6b007e7e7e7e7e7e7e7e7e7ea86c7e7eaa56ba01207f7588006b7600879163a86c7e7e6bbb6c7e7e6bbb6c7e7e6c6c75756b676d6d6d760087916378787e6c6c6c7e7b7c886c55798194547901157f597f5879527a517f77886c76537a517f77887c01217f6c76537a517f77887c597f6c76537a517f7781887c597f6c76537a517f7781887c517f7701207f756c7c886b6b6b6b6b6bbb6c7e7e6b676d6d6c6c6c75756b6868760119885279537f7701147f756c6c6c76547a8700886b6b6bbb6c7e7e6b760119885279537f7701147f756c6c567981008763527a75677b");
    prefix.push_str(&tax_address_hex);
    prefix.push_str("8868766b557981946b6bbb6c7e7e6b760119885279537f7701147f756c6c6c6c76557a8700886b6b5579819400886bbb6c7e7e6b527902");
    prefix.push_str(&ft_code_size);
    prefix.push_str("88768255947f05465461706588537f7701307f7500517a587f587f587f587f587f81567a937c81517a937c81517a937c81517a937c81517a937c81517a93597902");
    prefix.push_str(&ft_code_size);
    prefix.push_str("8857798255947f05465461706588537f7701307f7500517a587f587f587f587f587f81567a937c81517a937c81517a937c81517a937c81517a937c81517a936c6c6c6c765a79885f79885979517f7701147f75");
    prefix.push_str(&tax_address_hex);
    prefix.push_str("885f79517f7701147f75886c6c527a950340420f9676527a950340420f96547988537a947b886ba86c7e7e6bbb6c7e7e6ba86c7e7e6bbb6c7e7ea857ba8867528876a9");
    prefix.push_str(&hold_address_hex);
    prefix.push_str("88ad68516a07ffffffffffffff");
    Ok(prefix)
}

fn buy_order_prefix_hex(
    ft_code_size: usize,
    hold_address: &Address,
    tax_address: &Address,
) -> Result<String> {
    let mut prefix = String::new();
    let ft_code_size = ft_code_size_hex(ft_code_size)?;
    let mut hold_address_hex = String::new();
    push_hex_hash160(&mut hold_address_hex, hold_address);
    let mut tax_address_hex = String::new();
    push_hex_hash160(&mut tax_address_hex, tax_address);
    prefix.push_str("765187637556ba01207f77547f75817654958f01289351947901157f597f7701217f597f597f517f7701207f756b517f77816b517f77816b517f776b517f776b7654958f0128935394796b54958f0127935294796b006b7600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575687600879163bb7e6c7e6b6775757575686ca87e6b007e7e7e7e7e7e7e7e7e7ea86c7e7eaa56ba01207f7588006b760087636d6d6d7600879163bb6c7e7e676d6d6c686c6c75756b67577957797e6c6c6c7e7b7c88537902");
    prefix.push_str(&ft_code_size);
    prefix.push_str("88788255947f054654617065886c6c765879886b6b537f7701307f7500517a587f587f587f587f587f81567a937c81517a937c81517a937c81517a937c81517a937c81517a935679517f7701147f756b6b6ba86c7e7e6bbb6c7e7e6b527901157f597f6c6c6c6c76577a517f7788547a01217f6c76537a517f77887c597f6c76537a517f7781887c597f6c76537a517f7781767c88527a517f7701207f756c7c88587a517f7781517a950340420f96567a7c886b6b6b6b6b6bbb6c6c5279a97c887e7e6b68760119885279537f7701147f756c6c76537a8700886b6bbb6c7e7e6b760119885279537f7701147f756c55798100876377677c");
    prefix.push_str(&tax_address_hex);
    prefix.push_str("88685479816b6bbb6c7e7e6b760119885279537f7701147f756c6c6c76547a8878577981936c6c5279950340420f96547a886c527a950340420f967c6b7c6b6b6bbb6c7e7e6b527902");
    prefix.push_str(&ft_code_size);
    prefix.push_str("88768255947f05465461706588537f7701307f7500517a587f587f587f587f587f81567a937c81517a937c81517a937c81517a937c81517a937c81517a93597902");
    prefix.push_str(&ft_code_size);
    prefix.push_str("8857798255947f05465461706588537f7701307f7500517a587f587f587f587f587f81567a937c81517a937c81517a937c81517a937c81517a937c81517a936c6c6c6c765a79885f79885979517f7701147f75");
    prefix.push_str(&tax_address_hex);
    prefix.push_str("885f79517f7701147f75870088537a94527a9400886ba86c7e7e6bbb6c7e7e6ba86c7e7e6bbb6c7e7ea857ba8867528876a9");
    prefix.push_str(&hold_address_hex);
    prefix.push_str("88ad68516a30ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    Ok(prefix)
}

fn push_field(out: &mut Vec<u8>, data: &[u8]) {
    out.push(data.len() as u8);
    out.extend_from_slice(data);
}

fn decode_order_data_bytes(bytes: &[u8]) -> Result<OrderData> {
    let mut offset = 0usize;
    let hold_hash = read_fixed::<20>(bytes, &mut offset)?;
    let sale_volume = u64::from_le_bytes(read_fixed::<8>(bytes, &mut offset)?);
    let ft_partial_hash = read_fixed::<32>(bytes, &mut offset)?;
    let fee_rate = u64::from_le_bytes(read_fixed::<8>(bytes, &mut offset)?);
    let unit_price = u64::from_le_bytes(read_fixed::<8>(bytes, &mut offset)?);
    let ft_contract_id = read_fixed::<32>(bytes, &mut offset)?;
    if offset != bytes.len() {
        return Err(Error::InvalidScript("trailing order data".to_string()));
    }
    Ok(OrderData {
        hold_address: Address::from_hash160(hold_hash),
        sale_volume,
        ft_partial_hash,
        fee_rate,
        unit_price,
        ft_contract_id,
    })
}

fn read_fixed<const N: usize>(bytes: &[u8], offset: &mut usize) -> Result<[u8; N]> {
    if bytes.get(*offset) != Some(&(N as u8)) {
        return Err(Error::InvalidScript(
            "invalid order data field length".to_string(),
        ));
    }
    *offset += 1;
    let end = offset
        .checked_add(N)
        .ok_or_else(|| Error::InvalidScript("order data offset overflow".to_string()))?;
    let slice = bytes
        .get(*offset..end)
        .ok_or_else(|| Error::InvalidScript("truncated order data".to_string()))?;
    *offset = end;
    Ok(slice.try_into().expect("fixed-size slice length checked"))
}

#[cfg(test)]
mod js_166_tests {
    use super::*;

    #[test]
    fn order_v4_scripts_match_javascript_166() {
        let address = Address::from_string("1BitcoinEaterAddressDontSendf59kuE").unwrap();
        let data = OrderData {
            hold_address: address.clone(),
            sale_volume: 123_456,
            ft_partial_hash: [0x22; 32],
            fee_rate: 10_000,
            unit_price: 2_000_000,
            ft_contract_id: [0x11; 32],
        };
        let sell = sell_order_script_with_ft_size(&data, 2_076, &address).unwrap();
        let buy = buy_order_script_with_ft_size(&data, 2_076, &address).unwrap();

        assert_eq!(sell.as_bytes().len(), 946);
        assert_eq!(
            hex::encode(sell.sha256()),
            "bc7de1b3d4d789d0b879568d21e0d25f96da9eff524e7dd5f9b964d0bedafdf8"
        );
        assert_eq!(buy.as_bytes().len(), 1_074);
        assert_eq!(
            hex::encode(buy.sha256()),
            "9db9c7efe749124cdebeee95242b1b68e50c24a826ab98c5576832b894858325"
        );
    }
}
