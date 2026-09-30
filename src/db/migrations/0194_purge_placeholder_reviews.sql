-- Delete hand-seeded placeholder reviews.
--
-- PROBLEM: product_reviews was seeded by hand during development, and one
-- placeholder row (title "Test review", body "Test") was approved and left live
-- on the PUBLIC /reviews page — a fake review, credited to a "Verified player",
-- on the first page a visitor reads. The moderation queue cannot catch this,
-- because the row was approved on purpose.
--
-- RULE: delete a row only when BOTH the title and the body normalize (lowercase,
-- letters/digits only) to an empty string or to one of the placeholder tokens
-- below. A real review — however terse — keeps at least one field with actual
-- words, so it is never touched. This is the identical rule the public read path
-- applies in src/lib/reviews.ts (isPlaceholderReview), so nothing is deleted
-- here that the app would still be willing to publish.
--
-- Idempotent: the second run matches nothing.

DELETE FROM product_reviews AS target
USING (
  SELECT
    id,
    regexp_replace(lower(coalesce(title, '')), '[^a-z0-9]', '', 'g') AS title_key,
    regexp_replace(lower(coalesce(body, '')), '[^a-z0-9]', '', 'g') AS body_key
  FROM product_reviews
  WHERE status = 'approved'
) AS candidate
WHERE target.id = candidate.id
  AND (candidate.title_key = '' OR candidate.title_key IN (
    'test', 'testreview', 'testing', 'testtest',
    'asdf', 'asdfasdf', 'foo', 'bar', 'baz',
    'sample', 'samplesample', 'placeholder', 'dummy', 'loremipsum',
    'hello', 'helloworld', 'hi',
    'abc', 'abcabc', 'xyz', 'qwerty', 'aaa', 'bbb'
  ))
  AND (candidate.body_key = '' OR candidate.body_key IN (
    'test', 'testreview', 'testing', 'testtest',
    'asdf', 'asdfasdf', 'foo', 'bar', 'baz',
    'sample', 'samplesample', 'placeholder', 'dummy', 'loremipsum',
    'hello', 'helloworld', 'hi',
    'abc', 'abcabc', 'xyz', 'qwerty', 'aaa', 'bbb'
  ));
