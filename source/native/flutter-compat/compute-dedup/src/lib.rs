//! Packaging-only facade. Compile the unchanged native entry points into one
//! link unit so their dependencies can be shared. No new dispatch, signing,
//! error, allocation, or protocol implementation lives here.
//!
//! This template is staged inside the pinned workspace's crates directory.
//! Keep even the existing restricted private ABI; do not trim capabilities
//! merely because a Flutter test does not call them.
#[path = "../../tbc-engine-native/src/lib.rs"]
pub mod engine;
#[path = "../../tbc-keyless-native/src/lib.rs"]
pub mod keyless;
