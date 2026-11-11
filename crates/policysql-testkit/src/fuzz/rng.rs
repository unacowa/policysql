//! Deterministic pseudo-random numbers for the generators.
//!
//! xorshift64 seeded through splitmix64. Every statement can be reproduced from the numbers that
//! identify it (`mix(&[seed, round, index])`), so a failure never depends on generation order.

/// One splitmix64 step. Used to spread seeds and to mix several numbers into one seed.
#[must_use]
pub fn splitmix64(value: u64) -> u64 {
    let mut z = value.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Mixes several numbers into one seed. The order of the parts matters.
#[must_use]
pub fn mix(parts: &[u64]) -> u64 {
    parts
        .iter()
        .fold(0x0125_0125_0125_0125, |acc, part| splitmix64(acc ^ *part))
}

/// A xorshift64 generator. Never has an all-zero state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct XorShift64 {
    state: u64,
}

impl XorShift64 {
    /// Creates a generator from any seed (including 0).
    #[must_use]
    pub fn new(seed: u64) -> Self {
        let state = splitmix64(seed);
        Self {
            state: if state == 0 {
                0x9E37_79B9_7F4A_7C15
            } else {
                state
            },
        }
    }

    /// The next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    /// A number in `0..bound`. Returns 0 when `bound` is 0 or 1.
    pub fn below(&mut self, bound: usize) -> usize {
        if bound <= 1 {
            return 0;
        }
        let bound = u64::try_from(bound).unwrap_or(u64::MAX);
        usize::try_from(self.next_u64() % bound).unwrap_or(0)
    }

    /// True with probability `per_mille / 1000`.
    pub fn chance(&mut self, per_mille: u16) -> bool {
        self.next_u64() % 1000 < u64::from(per_mille)
    }

    /// True with probability `percent / 100`.
    pub fn percent(&mut self, percent: u16) -> bool {
        self.chance(percent.saturating_mul(10))
    }

    /// True or false with equal probability.
    pub fn coin(&mut self) -> bool {
        self.next_u64() & 1 == 1
    }

    /// A uniformly chosen element. Panics are avoided: an empty slice returns `None`.
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() {
            None
        } else {
            items.get(self.below(items.len()))
        }
    }

    /// Fisher-Yates shuffle.
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for index in (1..items.len()).rev() {
            let other = self.below(index + 1);
            items.swap(index, other);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_gives_the_same_sequence() {
        let mut a = XorShift64::new(42);
        let mut b = XorShift64::new(42);
        let left: Vec<u64> = (0..16).map(|_| a.next_u64()).collect();
        let right: Vec<u64> = (0..16).map(|_| b.next_u64()).collect();
        assert_eq!(left, right);
        let mut c = XorShift64::new(43);
        let other: Vec<u64> = (0..16).map(|_| c.next_u64()).collect();
        assert_ne!(left, other);
    }

    #[test]
    fn zero_seed_is_usable_and_mix_is_order_sensitive() {
        let mut rng = XorShift64::new(0);
        assert_ne!(rng.next_u64(), 0);
        assert_ne!(mix(&[1, 2]), mix(&[2, 1]));
        assert_eq!(mix(&[1, 2, 3]), mix(&[1, 2, 3]));
    }

    #[test]
    fn below_and_shuffle_stay_in_range() {
        let mut rng = XorShift64::new(7);
        for _ in 0..1000 {
            assert!(rng.below(5) < 5);
        }
        let mut items: Vec<u32> = (0..50).collect();
        rng.shuffle(&mut items);
        let mut sorted = items.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..50).collect::<Vec<u32>>());
    }
}
