//! Append-only Poseidon Merkle tree with a ring buffer of recent roots
//! (Tornado Nova style: leaves are inserted in pairs).
use crate::field::{Hasher, F32};
use near_sdk::store::LookupMap;
use near_sdk::{near, require, IntoStorageKey};

pub const LEVELS: usize = 20;
pub const ROOT_HISTORY: u32 = 1000;

#[near(serializers = [borsh])]
pub struct Tree {
    zeros: Vec<F32>,  // zeros[i] = root of an empty subtree of height i
    filled: Vec<F32>, // filled[i] = last left node at level i
    pub next_index: u32,
    root_index: u32,
    roots: LookupMap<u32, F32>,
    known: LookupMap<F32, u32>,
}

impl Tree {
    pub fn new<S: IntoStorageKey>(roots_prefix: S, known_prefix: S) -> Self {
        let mut h = Hasher::new();
        let mut zeros = vec![[0u8; 32]];
        for i in 0..LEVELS {
            let z = zeros[i];
            zeros.push(h.hash2(&z, &z));
        }
        let mut t = Tree {
            filled: zeros[..LEVELS].to_vec(),
            zeros,
            next_index: 0,
            root_index: 0,
            roots: LookupMap::new(roots_prefix),
            known: LookupMap::new(known_prefix),
        };
        let root = t.zeros[LEVELS];
        t.roots.insert(0, root);
        t.known.insert(root, 0);
        t
    }

    pub fn root(&self) -> F32 {
        *self.roots.get(&self.root_index).expect("root")
    }

    pub fn is_known_root(&self, root: &F32) -> bool {
        self.known.contains_key(root)
    }

    /// Inserts two leaves; returns the index of the first.
    pub fn insert_pair(&mut self, h: &mut Hasher, l: &F32, r: &F32) -> u32 {
        let first = self.next_index;
        require!((first as u64) + 2 <= 1u64 << LEVELS, "merkle tree is full");
        let mut idx = first / 2;
        let mut cur = h.hash2(l, r);
        for i in 1..LEVELS {
            let (left, right) = if idx % 2 == 0 {
                self.filled[i] = cur;
                (cur, self.zeros[i])
            } else {
                (self.filled[i], cur)
            };
            cur = h.hash2(&left, &right);
            idx /= 2;
        }
        let ni = (self.root_index + 1) % ROOT_HISTORY;
        if let Some(old) = self.roots.get(&ni).copied() {
            if self.known.get(&old) == Some(&ni) {
                self.known.remove(&old);
            }
        }
        self.roots.insert(ni, cur);
        self.known.insert(cur, ni);
        self.root_index = ni;
        self.next_index = first + 2;
        first
    }
}
