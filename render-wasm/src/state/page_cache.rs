use std::collections::VecDeque;

use super::ShapesPool;
use crate::shapes::{Shape, Type};
use crate::uuid::Uuid;

pub const DEFAULT_MAX_PAGES: usize = 3;
/// Largest weight a page may have to be cached. Heavier pages are never kept.
pub const DEFAULT_MAX_PAGE_WEIGHT: usize = 100_000;
/// Total weight of all cached pages. Three typical large pages (about 45k
/// each: 20k shapes, 15% texts, 20% paths) fit; two pages near the per-page
/// limit do too, three do not.
pub const DEFAULT_MAX_WEIGHT: usize = 200_000;

/// Weight of a text. Besides the shape struct, a text keeps its paragraphs and
/// spans (a string, fills and a font family per span) and the cached Skia
/// layout: paragraph builders and laid-out paragraphs with glyph runs and line
/// metrics. That is several times a plain shape.
pub const TEXT_WEIGHT: usize = 8;
/// Weight of a path or boolean: the shape struct plus its segment list and its
/// Skia path, about twice a plain shape.
pub const PATH_WEIGHT: usize = 2;

/// Rough memory weight of a shape; a plain shape weighs 1.
pub fn shape_weight(shape: &Shape) -> usize {
    match &shape.shape_type {
        Type::Text(_) => TEXT_WEIGHT,
        Type::Path(_) | Type::Bool(_) => PATH_WEIGHT,
        _ => 1,
    }
}

/// Weight of a pool: the sum over every slot, used or spare, since each slot
/// holds a shape struct.
pub fn pool_weight(pool: &ShapesPool) -> usize {
    pool.iter().map(shape_weight).sum()
}

/// Shapes pools of recently visited pages. Switching back to a cached page
/// restores its pool instead of uploading every shape again. Bounded by a page
/// count, a weight per page and a total weight; the least recently stashed page
/// goes first.
pub struct PageCache {
    /// Most recently stashed first, with the weight of each pool.
    entries: VecDeque<(Uuid, ShapesPool, usize)>,
    max_pages: usize,
    max_page_weight: usize,
    max_weight: usize,
    total_weight: usize,
    /// Page that a stash must not evict (see `set_keep`).
    keep: Option<Uuid>,
}

#[allow(dead_code)]
impl PageCache {
    /// Creates an empty cache with the default limits.
    pub fn new() -> Self {
        Self::with_limits(
            DEFAULT_MAX_PAGES,
            DEFAULT_MAX_PAGE_WEIGHT,
            DEFAULT_MAX_WEIGHT,
        )
    }

    /// Creates an empty cache with the given limits.
    pub fn with_limits(max_pages: usize, max_page_weight: usize, max_weight: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            max_pages,
            max_page_weight,
            max_weight,
            total_weight: 0,
            keep: None,
        }
    }

    /// True when a page of `weight` fits within the limits.
    pub fn accepts(&self, weight: usize) -> bool {
        self.max_pages > 0 && weight <= self.max_page_weight && weight <= self.max_weight
    }

    /// True when `pool` fits within the limits.
    pub fn accepts_pool(&self, pool: &ShapesPool) -> bool {
        self.accepts(pool_weight(pool))
    }

    /// Stores the pool of a page. Returns false when the pool is not kept,
    /// because the cache has no room for pages or the pool is too heavy.
    /// Other pages are only evicted when the pool is kept. While a page is set
    /// as `keep`, it is never evicted: a pool that does not fit beside it is
    /// refused instead.
    pub fn stash(&mut self, page_id: Uuid, pool: ShapesPool) -> bool {
        self.remove(&page_id);

        let weight = pool_weight(&pool);
        if !self.accepts(weight) {
            return false;
        }

        let keep = self.keep.filter(|keep| *keep != page_id);
        if let Some(kept_weight) = keep.and_then(|keep| self.weight_of(&keep)) {
            if self.max_pages < 2 || weight + kept_weight > self.max_weight {
                return false;
            }
        }

        self.total_weight += weight;
        self.entries.push_front((page_id, pool, weight));
        self.evict(keep);
        true
    }

    /// Protects the cached pool of `keep` from eviction while a stash runs (see
    /// `stash`). `None` restores plain eviction.
    pub fn set_keep(&mut self, keep: Option<Uuid>) {
        self.keep = keep;
    }

    /// Removes the pool of a page and returns it.
    pub fn take(&mut self, page_id: &Uuid) -> Option<ShapesPool> {
        let idx = self.entries.iter().position(|(id, _, _)| id == page_id)?;
        let (_, pool, weight) = self.entries.remove(idx)?;
        self.total_weight -= weight;
        Some(pool)
    }

    /// Drops the pool of a page. Returns true if the page was in the cache.
    pub fn remove(&mut self, page_id: &Uuid) -> bool {
        self.take(page_id).is_some()
    }

    /// Drops every pool.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.total_weight = 0;
    }

    /// Sets new limits and evicts pages until they hold.
    pub fn set_limits(&mut self, max_pages: usize, max_page_weight: usize, max_weight: usize) {
        self.max_pages = max_pages;
        self.max_page_weight = max_page_weight;
        self.max_weight = max_weight;
        self.evict(None);
    }

    /// Number of cached pages.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when no page is cached.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Total weight of all cached pools.
    pub fn total_weight(&self) -> usize {
        self.total_weight
    }

    /// True when the page has a cached pool.
    pub fn contains(&self, page_id: &Uuid) -> bool {
        self.entries.iter().any(|(id, _, _)| id == page_id)
    }

    /// Page id and weight of every cached pool, most recent first.
    pub fn cached(&self) -> Vec<(Uuid, usize)> {
        self.entries
            .iter()
            .map(|(id, _, weight)| (*id, *weight))
            .collect()
    }

    /// Weight of the cached pool of a page, if it is cached.
    fn weight_of(&self, page_id: &Uuid) -> Option<usize> {
        self.entries
            .iter()
            .find(|(id, _, _)| id == page_id)
            .map(|(_, _, weight)| *weight)
    }

    /// Drops the pages above the per-page weight limit, then the oldest pages
    /// until the count and total weight limits hold. The page `keep`, if any,
    /// is skipped by the count and total weight pass.
    fn evict(&mut self, keep: Option<Uuid>) {
        let max_page_weight = self.max_page_weight;
        let total_weight = &mut self.total_weight;
        self.entries.retain(|(_, _, weight)| {
            if *weight > max_page_weight {
                *total_weight -= *weight;
                false
            } else {
                true
            }
        });

        while self.entries.len() > self.max_pages || self.total_weight > self.max_weight {
            let Some(idx) = self
                .entries
                .iter()
                .rposition(|(id, _, _)| Some(*id) != keep)
            else {
                break;
            };
            let Some((_, _, weight)) = self.entries.remove(idx) else {
                break;
            };
            self.total_weight -= weight;
        }
    }
}

impl Default for PageCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{Bool, Path, TextContent};

    fn pool_with(n: usize) -> ShapesPool {
        let mut pool = ShapesPool::new();
        pool.initialize(n);
        for _ in 0..n {
            pool.add_shape(Uuid::new_v4());
        }
        pool
    }

    #[test]
    fn shape_weights_by_type() {
        let mut shape = Shape::new(Uuid::new_v4());
        assert_eq!(shape_weight(&shape), 1);

        shape.set_shape_type(Type::Text(TextContent::default()));
        assert_eq!(shape_weight(&shape), 8);

        shape.set_shape_type(Type::Path(Path::default()));
        assert_eq!(shape_weight(&shape), 2);

        shape.set_shape_type(Type::Bool(Bool::default()));
        assert_eq!(shape_weight(&shape), 2);
    }

    #[test]
    fn pool_weight_counts_texts_heavier() {
        let mut pool = pool_with(3);
        pool.iter_mut()
            .next()
            .expect("pool has shapes")
            .set_shape_type(Type::Text(TextContent::default()));

        assert_eq!(pool_weight(&pool), 10);
    }

    #[test]
    fn stash_then_take_returns_same_pool() {
        let mut cache = PageCache::new();
        let page = Uuid::new_v4();
        let shape_id = Uuid::new_v4();

        let mut pool = ShapesPool::new();
        pool.initialize(2);
        pool.add_shape(shape_id);
        pool.add_shape(Uuid::new_v4());

        assert!(cache.stash(page, pool));
        assert_eq!(cache.total_weight(), 2);

        let taken = cache.take(&page).expect("pool should be cached");
        assert_eq!(taken.len(), 2);
        assert!(taken.has(&shape_id));
        assert!(cache.is_empty());
        assert_eq!(cache.total_weight(), 0);
    }

    #[test]
    fn take_unknown_page_returns_none() {
        let mut cache = PageCache::new();
        assert!(cache.take(&Uuid::new_v4()).is_none());
    }

    #[test]
    fn stash_same_page_twice_keeps_one_entry() {
        let mut cache = PageCache::new();
        let page = Uuid::new_v4();

        assert!(cache.stash(page, pool_with(10)));
        assert!(cache.stash(page, pool_with(4)));

        assert_eq!(cache.len(), 1);
        assert_eq!(cache.total_weight(), 4);
    }

    #[test]
    fn lru_evicts_oldest_page_by_count() {
        let mut cache = PageCache::with_limits(3, 1000, 1000);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        let d = Uuid::new_v4();

        cache.stash(a, pool_with(10));
        cache.stash(b, pool_with(10));
        cache.stash(c, pool_with(10));
        cache.stash(d, pool_with(10));

        assert!(!cache.contains(&a));
        assert!(cache.contains(&b));
        assert!(cache.contains(&c));
        assert!(cache.contains(&d));
        assert_eq!(cache.len(), 3);
    }

    #[test]
    fn restashed_page_is_most_recent() {
        let mut cache = PageCache::with_limits(3, 1000, 1000);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        let d = Uuid::new_v4();

        cache.stash(a, pool_with(10));
        cache.stash(b, pool_with(10));
        cache.stash(c, pool_with(10));

        let pool_a = cache.take(&a).expect("a should be cached");
        cache.stash(a, pool_a);
        cache.stash(d, pool_with(10));

        assert!(!cache.contains(&b));
        assert!(cache.contains(&a));
        assert!(cache.contains(&c));
        assert!(cache.contains(&d));
    }

    #[test]
    fn shape_budget_evicts_oldest_pages() {
        let mut cache = PageCache::with_limits(10, 100, 100);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();

        cache.stash(a, pool_with(60));
        cache.stash(b, pool_with(30));
        cache.stash(c, pool_with(30));

        assert!(!cache.contains(&a));
        assert!(cache.contains(&b));
        assert!(cache.contains(&c));
        assert_eq!(cache.total_weight(), 60);
    }

    #[test]
    fn pool_larger_than_budget_is_rejected() {
        let mut cache = PageCache::with_limits(3, 50, 50);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();

        assert!(cache.stash(a, pool_with(20)));
        assert!(!cache.stash(b, pool_with(60)));

        assert!(cache.contains(&a));
        assert!(!cache.contains(&b));
        assert_eq!(cache.total_weight(), 20);
    }

    #[test]
    fn page_above_page_weight_is_rejected() {
        let mut cache = PageCache::with_limits(3, 50, 1000);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();

        assert!(cache.stash(a, pool_with(40)));
        assert!(!cache.stash(b, pool_with(60)));

        assert!(cache.contains(&a));
        assert!(!cache.contains(&b));
        assert_eq!(cache.total_weight(), 40);
    }

    #[test]
    fn set_limits_drops_pages_above_new_page_weight() {
        let mut cache = PageCache::with_limits(5, 100, 1000);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();

        cache.stash(a, pool_with(10));
        cache.stash(b, pool_with(60));
        cache.stash(c, pool_with(20));

        cache.set_limits(5, 50, 1000);

        assert!(cache.contains(&a));
        assert!(!cache.contains(&b));
        assert!(cache.contains(&c));
        assert_eq!(cache.total_weight(), 30);
    }

    #[test]
    fn total_weight_evicts_oldest() {
        let mut cache = PageCache::with_limits(10, 100, 100);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();

        let mut texts = pool_with(5);
        for shape in texts.iter_mut() {
            shape.set_shape_type(Type::Text(TextContent::default()));
        }

        assert!(cache.stash(a, texts));
        assert!(cache.stash(b, pool_with(40)));
        assert!(cache.stash(c, pool_with(30)));

        assert!(!cache.contains(&a));
        assert!(cache.contains(&b));
        assert!(cache.contains(&c));
        assert_eq!(cache.total_weight(), 70);
    }

    #[test]
    fn zero_max_pages_rejects_everything() {
        let mut cache = PageCache::with_limits(0, 1000, 1000);
        let a = Uuid::new_v4();

        assert!(!cache.stash(a, pool_with(10)));
        assert!(cache.is_empty());
        assert_eq!(cache.total_weight(), 0);
    }

    #[test]
    fn set_limits_shrinking_evicts_oldest() {
        let mut cache = PageCache::new();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();

        cache.stash(a, pool_with(10));
        cache.stash(b, pool_with(10));
        cache.stash(c, pool_with(10));

        cache.set_limits(1, 1000, 1000);

        assert_eq!(cache.len(), 1);
        assert!(cache.contains(&c));
        assert_eq!(cache.total_weight(), 10);
    }

    #[test]
    fn clear_and_remove_update_state() {
        let mut cache = PageCache::new();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();

        cache.stash(a, pool_with(10));
        assert!(cache.remove(&a));
        assert!(!cache.remove(&a));
        assert_eq!(cache.total_weight(), 0);

        cache.stash(a, pool_with(10));
        cache.stash(b, pool_with(10));
        cache.clear();

        assert!(cache.is_empty());
        assert_eq!(cache.total_weight(), 0);
    }

    #[test]
    fn kept_page_refuses_stash_that_would_evict_it() {
        let mut cache = PageCache::with_limits(3, 100, 150);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();

        assert!(cache.stash(a, pool_with(80)));
        cache.set_keep(Some(a));
        assert!(!cache.stash(b, pool_with(80)));

        assert!(cache.contains(&a));
        assert!(!cache.contains(&b));
        assert_eq!(cache.total_weight(), 80);
    }

    #[test]
    fn kept_page_is_skipped_by_eviction() {
        let mut cache = PageCache::with_limits(3, 100, 150);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        let d = Uuid::new_v4();

        cache.stash(a, pool_with(50));
        cache.stash(b, pool_with(50));
        cache.stash(c, pool_with(50));
        cache.set_keep(Some(a));
        assert!(cache.stash(d, pool_with(50)));

        assert!(cache.contains(&a));
        assert!(!cache.contains(&b));
        assert!(cache.contains(&c));
        assert!(cache.contains(&d));
        assert_eq!(cache.total_weight(), 150);
    }

    #[test]
    fn without_keep_stash_evicts_oldest_page() {
        let mut cache = PageCache::with_limits(3, 100, 150);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        let d = Uuid::new_v4();

        cache.stash(a, pool_with(50));
        cache.stash(b, pool_with(50));
        cache.stash(c, pool_with(50));
        assert!(cache.stash(d, pool_with(50)));

        assert!(!cache.contains(&a));
        assert!(cache.contains(&b));
        assert!(cache.contains(&c));
        assert!(cache.contains(&d));
        assert_eq!(cache.total_weight(), 150);
    }

    #[test]
    fn cached_lists_ids_and_weights_most_recent_first() {
        let mut cache = PageCache::new();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();

        cache.stash(a, pool_with(10));
        cache.stash(b, pool_with(20));

        assert_eq!(cache.cached(), vec![(b, 20), (a, 10)]);
    }
}
