//! Wrap-safe idle arithmetic for the Windows idle probe (task T9, spec S8.5).
//!
//! `GetLastInputInfo` reports the tick of the last input as a 32-bit
//! millisecond stamp (`dwTime`), which wraps about every 49.7 days. The current
//! uptime comes from the 64-bit `GetTickCount64`. Only the low 32 bits of the
//! two are comparable, so the difference is taken modulo 2^32.

/// Milliseconds since the last input, given the current uptime in ms and the
/// 32-bit tick stamp of the last input.
pub fn idle_ms(now_ms: u64, last_input_tick: u32) -> u64 {
    // `dwTime` is the uptime modulo 2^32, so compare it with the uptime's low
    // 32 bits; wrapping_sub is exact while the idle time stays under 49.7 days.
    u64::from((now_ms as u32).wrapping_sub(last_input_tick))
}

#[cfg(test)]
mod tests {
    use super::idle_ms;

    #[test]
    fn a_normal_difference_is_now_minus_last() {
        assert_eq!(idle_ms(1_000_000, 400_000), 600_000);
    }

    #[test]
    fn equal_stamps_mean_zero_idle() {
        assert_eq!(idle_ms(123_456, 123_456), 0);
        assert_eq!(idle_ms(1u64 << 32, 0), 0);
    }

    #[test]
    fn a_counter_just_past_the_wrap_with_input_before_it_is_ten_ms() {
        // Input at uptime 2^32 + 90 ms is stamped 90 (the u32 wrapped); now is
        // 2^32 + 100 ms. The user was last active 10 ms ago, not 49.7 days.
        assert_eq!(idle_ms((1u64 << 32) + 100, 90), 10);
    }

    #[test]
    fn input_before_the_wrap_and_now_after_it_is_still_correct() {
        // Input 5 ms before the wrap, now 5 ms after it: 10 ms.
        assert_eq!(idle_ms((1u64 << 32) + 5, u32::MAX - 4), 10);
    }

    #[test]
    fn a_long_uptime_with_recent_input_stays_small() {
        // 100 days of uptime, input 90 ms ago.
        let now = 100u64 * 24 * 3600 * 1000;
        let last = (now - 90) as u32;
        assert_eq!(idle_ms(now, last), 90);
    }
}
