import unittest

from scripts.showcase.select_subset import allocate, pick, top_category


def row(task_id, category, label=None, author="alice", quality=5, luna=0.1):
    return {
        "task_id": task_id, "category": category, "label": label or f"{category} > x",
        "participant_id": author, "quality": quality, "luna_score": luna,
    }


class AllocateTests(unittest.TestCase):
    def test_a_small_category_is_not_drowned_by_a_large_one(self):
        # Proportional sampling would give the 2-task category ~0 slots; the
        # floor is what keeps the tail of the taxonomy represented at all.
        quota = allocate({"big": 60, "small": 2, "mid": 20}, total=30, floor=4)
        self.assertEqual(quota["small"], 2)
        self.assertEqual(sum(quota.values()), 30)
        self.assertGreaterEqual(quota["big"], 4)

    def test_it_never_promises_more_than_a_category_holds(self):
        quota = allocate({"a": 3, "b": 3}, total=100, floor=4)
        self.assertEqual(quota, {"a": 3, "b": 3})

    def test_surplus_levels_up_instead_of_feeding_the_biggest(self):
        # Awarding surplus by raw headroom would give "a" all four spare slots.
        quota = allocate({"a": 50, "b": 5}, total=12, floor=4)
        self.assertEqual(quota, {"a": 7, "b": 5})

    def test_a_large_category_cannot_absorb_the_whole_surplus(self):
        quota = allocate({"a": 100, "b": 10, "c": 10}, total=24, floor=4)
        self.assertEqual(sum(quota.values()), 24)
        self.assertLessEqual(max(quota.values()) - min(quota.values()), 1)


class PickTests(unittest.TestCase):
    def test_no_single_author_can_dominate(self):
        rows = [row(f"t{i}", "cat", author="alice") for i in range(10)]
        chosen = pick(rows, {"cat": 10}, author_cap=3)
        self.assertEqual(len(chosen), 3)

    def test_sub_labels_are_spread_before_they_are_repeated(self):
        rows = [
            row("a1", "cat", label="cat > one", quality=5),
            row("a2", "cat", label="cat > one", quality=5),
            row("a3", "cat", label="cat > two", quality=4),
        ]
        chosen = pick(rows, {"cat": 2}, author_cap=8)
        self.assertEqual({c["label"] for c in chosen}, {"cat > one", "cat > two"})

    def test_within_a_category_the_weakest_baseline_wins_the_tie(self):
        rows = [
            row("easy", "cat", label="cat > one", quality=5, luna=0.30),
            row("hard", "cat", label="cat > two", quality=5, luna=0.02),
        ]
        chosen = pick(rows, {"cat": 1}, author_cap=8)
        self.assertEqual(chosen[0]["task_id"], "hard")

    def test_quality_outranks_difficulty(self):
        # A harder task must not displace a better-screened one.
        rows = [
            row("good", "cat", label="cat > one", quality=5, luna=0.30),
            row("weak", "cat", label="cat > two", quality=3, luna=0.00),
        ]
        chosen = pick(rows, {"cat": 1}, author_cap=8)
        self.assertEqual(chosen[0]["task_id"], "good")


class TopCategoryTests(unittest.TestCase):
    def test_it_reads_the_head_of_a_similarweb_path(self):
        self.assertEqual(top_category(["Travel and Tourism > Hotels"]), "Travel and Tourism")
        self.assertEqual(top_category([]), "Uncategorized")
        self.assertEqual(top_category(None), "Uncategorized")


if __name__ == "__main__":
    unittest.main()


class LoadScreensTests(unittest.TestCase):
    def test_a_rescreen_replaces_the_pass_it_corrects(self):
        import json, tempfile
        from pathlib import Path
        from scripts.showcase.select_subset import load_screens
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "out-00.json").write_text(json.dumps(
                [{"task_id": "t1", "fair": True, "quality": 3},
                 {"task_id": "t2", "fair": True, "quality": 5}]))
            # Judged again on untruncated text; this verdict must win outright.
            (root / "rescreen-00.json").write_text(json.dumps(
                [{"task_id": "t1", "fair": True, "quality": 5}]))
            screens = load_screens(root)
        self.assertEqual(screens["t1"]["quality"], 5)
        self.assertEqual(screens["t2"]["quality"], 5)
        self.assertEqual(len(screens), 2)


class FillTests(unittest.TestCase):
    def test_a_thin_category_is_not_starved_by_a_prolific_author(self):
        # "big" is filled first under the old ordering, spending alice's cap and
        # leaving "thin" -- which only alice writes for -- with nothing.
        rows = [row(f"b{i}", "big", label=f"big > {i}", author="alice") for i in range(10)]
        rows += [row("t1", "thin", label="thin > one", author="alice")]
        chosen = pick(rows, {"big": 5, "thin": 1}, author_cap=6, total=6)
        self.assertIn("t1", {c["task_id"] for c in chosen})

    def test_unfillable_slots_are_re_offered_instead_of_lost(self):
        rows = [row("a1", "one", label="one > a", author="alice"),
                row("b1", "two", label="two > a", author="bob"),
                row("b2", "two", label="two > b", author="bob")]
        # "one" can seat only 1, so its second slot must be re-offered to "two".
        chosen = pick(rows, {"one": 2, "two": 1}, author_cap=8, total=3)
        self.assertEqual(len(chosen), 3)

    def test_the_author_cap_still_binds_during_the_fill(self):
        rows = [row(f"a{i}", "one", label=f"one > {i}", author="alice") for i in range(10)]
        chosen = pick(rows, {"one": 2}, author_cap=3, total=10)
        self.assertEqual(len(chosen), 3)
