SELECT
    denial_reason,
    COUNT(*) AS denial_count,
    MIN(verified_at) AS first_occurrence,
    MAX(verified_at) AS latest_occurrence
FROM verification_log
WHERE decision <> 'allow'
  AND verified_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
GROUP BY denial_reason
ORDER BY denial_count DESC, denial_reason ASC;
