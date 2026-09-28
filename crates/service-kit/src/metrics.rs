use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use dashmap::DashMap;

const LATENCY_BUCKETS_MS: [u64; 12] = [25, 50, 100, 250, 500, 1_000, 1_500, 2_500, 5_000, 10_000, 20_000, 30_000];

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct SeriesKey {
    name: &'static str,
    label: &'static str,
    value: String,
}

#[derive(Debug, Default)]
struct Histogram {
    buckets: [AtomicU64; 12],
    count: AtomicU64,
    sum_ms: AtomicU64,
}

#[derive(Debug)]
pub struct Metrics {
    prefix: &'static str,
    gauges: DashMap<&'static str, AtomicI64>,
    counters: DashMap<SeriesKey, AtomicU64>,
    histograms: DashMap<SeriesKey, Histogram>,
}

fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

impl Metrics {
    #[must_use]
    pub fn new(prefix: &'static str) -> Self {
        let metrics = Self { prefix, gauges: DashMap::new(), counters: DashMap::new(), histograms: DashMap::new() };
        metrics.gauges.insert("active_calls", AtomicI64::new(0));
        metrics.gauges.insert("pending_call_setups", AtomicI64::new(0));
        metrics
    }

    pub fn increment(&self, name: &'static str, label: &'static str, value: &str) {
        self.add(name, label, value, 1);
    }

    pub fn add(&self, name: &'static str, label: &'static str, value: &str, amount: u64) {
        self.counters.entry(SeriesKey { name, label, value: value.to_owned() }).or_default().fetch_add(amount, Ordering::Relaxed);
    }

    pub fn observe_ms(&self, name: &'static str, label: &'static str, value: &str, milliseconds: u64) {
        let entry = self.histograms.entry(SeriesKey { name, label, value: value.to_owned() }).or_default();
        if let Some(index) = LATENCY_BUCKETS_MS.iter().position(|bound| milliseconds <= *bound)
            && let Some(bucket) = entry.buckets.get(index)
        {
            bucket.fetch_add(1, Ordering::Relaxed);
        }
        entry.count.fetch_add(1, Ordering::Relaxed);
        entry.sum_ms.fetch_add(milliseconds, Ordering::Relaxed);
    }

    pub fn adjust_gauge(&self, name: &'static str, delta: i64) {
        self.gauges.entry(name).or_default().fetch_add(delta, Ordering::SeqCst);
    }

    pub fn set_gauge(&self, name: &'static str, value: i64) {
        self.gauges.entry(name).or_default().store(value, Ordering::SeqCst);
    }

    #[must_use]
    pub fn gauge(&self, name: &'static str) -> i64 {
        self.gauges.get(name).map_or(0, |gauge| gauge.load(Ordering::SeqCst))
    }

    pub fn add_active_calls(&self, delta: i64) {
        self.adjust_gauge("active_calls", delta);
    }

    pub fn add_pending_setups(&self, delta: i64) {
        self.adjust_gauge("pending_call_setups", delta);
    }

    #[must_use]
    pub fn active_calls(&self) -> i64 {
        self.gauge("active_calls")
    }

    #[must_use]
    pub fn counter(&self, name: &'static str, label: &'static str, value: &str) -> u64 {
        self.counters.get(&SeriesKey { name, label, value: value.to_owned() }).map_or(0, |counter| counter.load(Ordering::Relaxed))
    }

    #[must_use]
    pub fn render(&self) -> String {
        let prefix = self.prefix;
        let mut output = String::new();
        let gauges: BTreeMap<&'static str, i64> = self.gauges.iter().map(|entry| (*entry.key(), entry.value().load(Ordering::SeqCst))).collect();
        for (name, value) in gauges {
            let _ = writeln!(output, "# TYPE {prefix}{name} gauge\n{prefix}{name} {value}");
        }
        let counters: BTreeMap<SeriesKey, u64> = self.counters.iter().map(|entry| (entry.key().clone(), entry.value().load(Ordering::Relaxed))).collect();
        let mut current = "";
        for (key, value) in &counters {
            if key.name != current {
                let _ = writeln!(output, "# TYPE {prefix}{}_total counter", key.name);
                current = key.name;
            }
            let _ = writeln!(output, "{prefix}{}_total{{{}=\"{}\"}} {value}", key.name, key.label, escape(&key.value));
        }
        let mut histograms: Vec<(SeriesKey, [u64; 12], u64, u64)> = self
            .histograms
            .iter()
            .map(|entry| {
                let histogram = entry.value();
                (
                    entry.key().clone(),
                    std::array::from_fn(|index| histogram.buckets.get(index).map_or(0, |bucket| bucket.load(Ordering::Relaxed))),
                    histogram.count.load(Ordering::Relaxed),
                    histogram.sum_ms.load(Ordering::Relaxed),
                )
            })
            .collect();
        histograms.sort_by(|left, right| left.0.cmp(&right.0));
        let mut current = "";
        for (key, buckets, count, sum) in &histograms {
            if key.name != current {
                let _ = writeln!(output, "# TYPE {prefix}{}_milliseconds histogram", key.name);
                current = key.name;
            }
            let label = format!("{}=\"{}\"", key.label, escape(&key.value));
            let mut cumulative = 0_u64;
            for (bound, bucket) in LATENCY_BUCKETS_MS.iter().zip(buckets.iter()) {
                cumulative += bucket;
                let _ = writeln!(output, "{prefix}{}_milliseconds_bucket{{{label},le=\"{bound}\"}} {cumulative}", key.name);
            }
            let _ = writeln!(output, "{prefix}{}_milliseconds_bucket{{{label},le=\"+Inf\"}} {count}", key.name);
            let _ = writeln!(output, "{prefix}{}_milliseconds_sum{{{label}}} {sum}", key.name);
            let _ = writeln!(output, "{prefix}{}_milliseconds_count{{{label}}} {count}", key.name);
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_prometheus_text_with_cumulative_buckets_and_escaped_labels() {
        let metrics = Metrics::new("velyric_test_");
        metrics.add_active_calls(2);
        metrics.add_active_calls(-1);
        metrics.set_gauge("consumer_lag", 17);
        metrics.increment("admission_rejected", "reason", "TENANT_CONCURRENCY_LIMIT");
        metrics.add("admission_rejected", "reason", "TENANT_CONCURRENCY_LIMIT", 2);
        metrics.increment("sideband_events", "type", "weird\"type");
        metrics.observe_ms("tool_latency", "tool", "lookup_availability", 40);
        metrics.observe_ms("tool_latency", "tool", "lookup_availability", 1_200);
        metrics.observe_ms("tool_latency", "tool", "lookup_availability", 45_000);
        let text = metrics.render();
        assert!(text.contains("velyric_test_active_calls 1\n"));
        assert!(text.contains("velyric_test_consumer_lag 17\n"));
        assert!(text.contains("velyric_test_admission_rejected_total{reason=\"TENANT_CONCURRENCY_LIMIT\"} 3\n"));
        assert!(text.contains("velyric_test_sideband_events_total{type=\"weird\\\"type\"} 1\n"));
        assert!(text.contains("velyric_test_tool_latency_milliseconds_bucket{tool=\"lookup_availability\",le=\"50\"} 1\n"));
        assert!(text.contains("velyric_test_tool_latency_milliseconds_bucket{tool=\"lookup_availability\",le=\"1500\"} 2\n"));
        assert!(text.contains("velyric_test_tool_latency_milliseconds_bucket{tool=\"lookup_availability\",le=\"+Inf\"} 3\n"));
        assert!(text.contains("velyric_test_tool_latency_milliseconds_sum{tool=\"lookup_availability\"} 46240\n"));
        assert_eq!(metrics.counter("admission_rejected", "reason", "TENANT_CONCURRENCY_LIMIT"), 3);
        assert_eq!(metrics.active_calls(), 1);
    }
}
