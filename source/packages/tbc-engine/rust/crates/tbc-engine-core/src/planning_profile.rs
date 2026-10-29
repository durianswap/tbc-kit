//! Opt-in local benchmark instrumentation. No material or secret is recorded.
use std::{cell::RefCell, collections::BTreeMap, time::Instant};
use serde::Serialize;
#[derive(Default, Serialize)]
pub struct Measurement { pub calls: u64, pub nanos: u128 }
thread_local! { static DATA: RefCell<BTreeMap<&'static str, Measurement>> = RefCell::new(BTreeMap::new()); }
pub struct Span { name: &'static str, start: Instant }
impl Span {
    pub fn new(name: &'static str) -> Self { Self { name, start: Instant::now() } }
}
impl Drop for Span {
    fn drop(&mut self) {
        let nanos = self.start.elapsed().as_nanos();
        DATA.with(|data| { let mut data = data.borrow_mut(); let item = data.entry(self.name).or_default(); item.calls += 1; item.nanos += nanos; });
    }
}
pub fn take() -> BTreeMap<&'static str, Measurement> { DATA.with(|data| std::mem::take(&mut *data.borrow_mut())) }
