//! Compiles only checked-in Pool3/LP templates once. Never interprets user templates.
use std::{collections::BTreeMap, ops::Range};
use super::amm::{AmmError, Result};

pub(super) type Values = BTreeMap<&'static str, Vec<u8>>;
pub(super) struct Template {
    bytes: Vec<u8>,
    constants: Vec<Range<usize>>,
    fields: Vec<(&'static str, Range<usize>)>,
}
impl Template {
    pub fn compile(mut source: &'static str, fields: &[(&'static str, usize)]) -> Self {
        source=source.trim();
        let mut result=Self {bytes:Vec::new(), constants:Vec::new(), fields:Vec::new()};
        while !source.is_empty() {
            let end=source.find('<').unwrap_or(source.len());
            let start=result.bytes.len();
            assert_eq!(end%2,0,"pinned template hex width");
            for i in (0..end).step_by(2) {
                result.bytes.push(u8::from_str_radix(&source[i..i+2],16).expect("pinned template hex"));
            }
            source=&source[end..];
            if source.is_empty() {result.constants.push(start..result.bytes.len());break;}
            let end=source.find('>').expect("pinned placeholder")+1;
            let &(label,width)=fields.iter().find(|(label,_)|*label==&source[..end]).expect("known pinned field");
            assert!(width<=75);
            result.bytes.push(width as u8);
            result.constants.push(start..result.bytes.len());
            let offset=result.bytes.len();result.bytes.resize(offset+width,0);
            result.fields.push((label,offset..offset+width));source=&source[end..];
        }
        result
    }
    pub fn len(&self) -> usize {self.bytes.len()}
    pub fn instantiate(&self, values:&Values) -> Result<Vec<u8>> {
        let mut bytes=self.bytes.clone();
        for (label,range) in &self.fields {
            let value=values.get(label).ok_or(AmmError("Missing AMM constructor field"))?;
            if value.len()!=range.len() {return Err(AmmError("Invalid AMM constructor width"));}
            bytes[range.clone()].copy_from_slice(value);
        }
        Ok(bytes)
    }
    /// Returns fields for a fixed prefix. Caller MUST validate any trailing bytes.
    pub fn parse_prefix(&self, bytes:&[u8]) -> Result<Values> {
        if bytes.len()<self.len() {return Err(AmmError("Truncated AMM template"));}
        for range in &self.constants {
            if bytes[range.clone()]!=self.bytes[range.clone()] {return Err(AmmError("Modified AMM template"));}
        }
        let mut values=Values::new();
        for (label,range) in &self.fields {
            let value=bytes[range.clone()].to_vec();
            if values.get(label).is_some_and(|previous|previous!=&value) {
                return Err(AmmError("Inconsistent repeated AMM constructor field"));
            }
            values.insert(*label,value);
        }
        Ok(values)
    }
}
