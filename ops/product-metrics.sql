WITH funnel AS (
  SELECT
    COUNT(DISTINCT CASE WHEN name = 'visited' THEN session_id END) AS users,
    COUNT(DISTINCT CASE WHEN name = 'board_created' THEN session_id END) AS creators,
    COUNT(DISTINCT CASE WHEN name = 'board_opened' THEN session_id END) AS openers,
    COUNT(DISTINCT CASE WHEN name = 'post_created' THEN session_id END) AS posters,
    COUNT(DISTINCT CASE WHEN name = 'comment_created' THEN session_id END) AS commenters,
    COUNT(DISTINCT CASE WHEN name = 'acknowledged' THEN session_id END) AS acknowledgers,
    COUNT(DISTINCT CASE WHEN name = 'photo_added' THEN session_id END) AS photo_users,
    COUNT(DISTINCT CASE WHEN name = 'board_exported' THEN session_id END) AS exporters,
    COUNT(DISTINCT CASE WHEN name = 'returned' THEN session_id END) AS returned,
    COUNT(DISTINCT CASE WHEN name = 'board_created' AND created_at >= unixepoch() - 604800 THEN board_id END) AS boards_created_7d,
    COUNT(DISTINCT CASE WHEN name = 'board_opened' AND created_at >= unixepoch() - 604800 THEN board_id END) AS boards_opened_7d
  FROM product_events
  WHERE is_qa = 0
)
SELECT
  funnel.*,
  (SELECT COUNT(*) FROM boards WHERE expires_at > unixepoch()) AS active_boards,
  (SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL) AS posts,
  (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL) AS comments,
  (SELECT COUNT(*) FROM acknowledgements) AS acknowledgements
FROM funnel;
