"""WP 4.4 routing corpus in CI (doc 11 §2.3): every corpus/*.json scenario passes all invariants (E4 exit: 30/30)."""
import os

import pytest

import corpus_gen
import corpus_run

FILES = corpus_run.scenario_files()


def test_corpus_has_at_least_30_scenarios():
    assert len(FILES) >= 30
    ids = [corpus_run.load(f)['id'] for f in FILES]
    assert len(set(ids)) == len(ids)


@pytest.mark.parametrize('path', FILES, ids=[os.path.basename(f)[:-5] for f in FILES])
def test_corpus_scenario(path):
    r = corpus_run.run_one(path)
    assert r['pass'], r['failures']
    assert r['matrixSource'] == corpus_gen.MATRIX_SOURCE


def test_generator_is_deterministic():
    spec = corpus_run.load(FILES[0])
    assert corpus_gen.build(spec) == corpus_gen.build(spec)
