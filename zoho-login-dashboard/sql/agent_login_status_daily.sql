-- =============================================================================
-- zoho_crm.agent_login_status_daily
-- -----------------------------------------------------------------------------
-- Materialised copy of the "Agents" table on the Zoho Login & Status tab
-- (main.py::_users_query), at grain = one row per agent per IST day.
-- Sum / max over any date range to reproduce the dashboard for that range.
--
-- Column logic (identical to the live dashboard):
--   is_online_now   crm_users.is_online  (Zoho "Isonline" flag at the last /sync poll)
--   login_hours     user_status_snapshots: for every ONLINE snapshot, time until the
--                   next snapshot of the same agent, capped at 1800 s (30 min) so a
--                   missed poll can't inflate hours. Gap is measured within the IST day.
--   active_hours    count of distinct IST clock-hours with >=1 call/task/meeting/
--                   online_activity in zoho_crm.all_activity (presence by activity)
--   first/last_activity  MIN/MAX activity_time from the same feed
--   deals_created   cdc_deals by Created_Time
--   won_deals / won_value  cdc_deals Stage='Closed Won' by Closing_Date
--   calls / talk_min  cdc_calls by Call_Start_Time, Call_Duration_in_seconds/60
--   meetings        cdc_meetings by Start_DateTime
--   tasks           cdc_tasks by Created_Time
--   online_acts     cdc_online_activities by Event_time (fallback created_time)
--
-- Refresh: full rebuild (sources are small, ~220 MB scanned). Scheduled query,
-- daily at 10:00 IST (DTS schedule "every day 04:30" UTC).
-- =============================================================================
CREATE OR REPLACE TABLE `lucirajewelry-prod.zoho_crm.agent_login_status_daily`
PARTITION BY activity_date
CLUSTER BY user_id
OPTIONS (description = 'Zoho Login & Status tab - per agent per IST day. Rebuilt by scheduled query. Logic mirrors zoho-login-dashboard main.py _users_query.')
AS
WITH
today AS (SELECT CURRENT_DATE('Asia/Kolkata') AS d),

snap AS (
  SELECT user_id, snapshot_time, is_online,
         DATE(snapshot_time, 'Asia/Kolkata') AS activity_date,
         LEAD(snapshot_time) OVER (
           PARTITION BY user_id, DATE(snapshot_time, 'Asia/Kolkata')
           ORDER BY snapshot_time) AS nx
  FROM `lucirajewelry-prod.zoho_crm.user_status_snapshots`
),
online AS (
  SELECT user_id, activity_date,
         SUM(IF(is_online, LEAST(TIMESTAMP_DIFF(nx, snapshot_time, SECOND), 1800), 0)) / 3600.0 AS login_hours,
         COUNTIF(is_online) AS online_polls,
         COUNT(*)           AS total_polls,
         MIN(IF(is_online, snapshot_time, NULL)) AS first_seen_online,
         MAX(IF(is_online, snapshot_time, NULL)) AS last_seen_online
  FROM snap GROUP BY 1, 2
),

deals_created AS (
  SELECT owner_id AS user_id, DATE(created_time, 'Asia/Kolkata') AS activity_date,
         COUNT(*) AS deals_created
  FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
  GROUP BY 1, 2
),
deals_won AS (
  SELECT owner_id AS user_id,
         SAFE.PARSE_DATE('%F', JSON_VALUE(data, '$.Closing_Date')) AS activity_date,
         COUNT(*) AS won_deals,
         SUM(COALESCE(SAFE_CAST(JSON_VALUE(data, '$.Amount') AS FLOAT64), 0)) AS won_value
  FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
  WHERE JSON_VALUE(data, '$.Stage') = 'Closed Won'
  GROUP BY 1, 2
),
calls AS (
  SELECT owner_id AS user_id,
         DATE(SAFE.PARSE_TIMESTAMP('%FT%T%Ez', JSON_VALUE(data, '$.Call_Start_Time')), 'Asia/Kolkata') AS activity_date,
         COUNT(*) AS calls,
         COALESCE(SUM(SAFE_CAST(JSON_VALUE(data, '$.Call_Duration_in_seconds') AS FLOAT64)), 0) / 60.0 AS talk_min
  FROM `lucirajewelry-prod.zoho_crm.cdc_calls`
  GROUP BY 1, 2
),
meetings AS (
  SELECT owner_id AS user_id,
         DATE(SAFE.PARSE_TIMESTAMP('%FT%T%Ez', JSON_VALUE(data, '$.Start_DateTime')), 'Asia/Kolkata') AS activity_date,
         COUNT(*) AS meetings
  FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`
  GROUP BY 1, 2
),
tasks AS (
  SELECT owner_id AS user_id, DATE(created_time, 'Asia/Kolkata') AS activity_date,
         COUNT(*) AS tasks
  FROM `lucirajewelry-prod.zoho_crm.cdc_tasks`
  GROUP BY 1, 2
),
oacts AS (
  SELECT owner_id AS user_id,
         DATE(COALESCE(SAFE.PARSE_TIMESTAMP('%FT%T%Ez', JSON_VALUE(data, '$.Event_time')), created_time),
              'Asia/Kolkata') AS activity_date,
         COUNT(*) AS online_acts
  FROM `lucirajewelry-prod.zoho_crm.cdc_online_activities`
  GROUP BY 1, 2
),
presence AS (
  SELECT owner_id AS user_id, DATE(activity_time, 'Asia/Kolkata') AS activity_date,
         MIN(activity_time) AS first_activity,
         MAX(activity_time) AS last_activity,
         COUNT(DISTINCT FORMAT_TIMESTAMP('%F-%H', activity_time, 'Asia/Kolkata')) AS active_hours
  FROM `lucirajewelry-prod.zoho_crm.all_activity`
  WHERE activity_type IN ('call', 'task', 'meeting', 'online_activity')
  GROUP BY 1, 2
),

-- ---------------------------------------------------------------------------
-- WORKING HOURS = how long the agent was actually at work that day.
-- Every piece of evidence becomes a time block:
--   * online poll      -> [poll, next poll] (max 30 min)
--   * call             -> [call start, call start + duration]
--   * task / deal the agent CREATED THEMSELVES -> a point in time
--     (99.7% of deals are created by the "Lucira Tech" integration and only
--      auto-assigned, so only Created_By = owner counts as the agent's own work)
-- Blocks less than 30 min apart are joined into one work session (the agent was
-- working in between). working_hours = total length of all sessions. A gap of
-- more than 30 min with no evidence = break / away.
-- Meetings (scheduled time, not when work happened) and online activities
-- (customer-side events) are NOT used here.
-- ---------------------------------------------------------------------------
work_ev AS (
  SELECT user_id, snapshot_time AS s,
         TIMESTAMP_ADD(snapshot_time, INTERVAL LEAST(IFNULL(TIMESTAMP_DIFF(nx, snapshot_time, SECOND), 0), 1800) SECOND) AS e
  FROM snap WHERE is_online
  UNION ALL
  SELECT owner_id, cs,
         TIMESTAMP_ADD(cs, INTERVAL CAST(IFNULL(SAFE_CAST(JSON_VALUE(data, '$.Call_Duration_in_seconds') AS FLOAT64), 0) AS INT64) SECOND)
  FROM (SELECT *, SAFE.PARSE_TIMESTAMP('%FT%T%Ez', JSON_VALUE(data, '$.Call_Start_Time')) AS cs
        FROM `lucirajewelry-prod.zoho_crm.cdc_calls`)
  WHERE cs IS NOT NULL AND JSON_VALUE(data, '$.Created_By.id') = owner_id
  UNION ALL
  SELECT owner_id, created_time, created_time FROM `lucirajewelry-prod.zoho_crm.cdc_tasks`
  WHERE JSON_VALUE(data, '$.Created_By.id') = owner_id
  UNION ALL
  SELECT owner_id, created_time, created_time FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
  WHERE JSON_VALUE(data, '$.Created_By.id') = owner_id
),
work_ord AS (
  SELECT user_id, s, e, DATE(s, 'Asia/Kolkata') AS activity_date,
         MAX(e) OVER (PARTITION BY user_id, DATE(s, 'Asia/Kolkata') ORDER BY s, e
                      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
  FROM work_ev
),
work_sid AS (
  SELECT *, SUM(IF(prev_end IS NULL OR s > TIMESTAMP_ADD(prev_end, INTERVAL 30 MINUTE), 1, 0))
              OVER (PARTITION BY user_id, activity_date ORDER BY s, e) AS sid
  FROM work_ord
),
work_sess AS (
  SELECT user_id, activity_date, sid, MIN(s) AS a, MAX(e) AS b
  FROM work_sid GROUP BY 1, 2, 3
),
work AS (
  SELECT user_id, activity_date,
         SUM(TIMESTAMP_DIFF(b, a, SECOND)) / 3600.0 AS working_hours,
         COUNT(*) AS work_sessions,
         MIN(a) AS work_start,
         MAX(b) AS work_end
  FROM work_sess GROUP BY 1, 2
),

keys AS (
  SELECT user_id, activity_date FROM online
  UNION DISTINCT SELECT user_id, activity_date FROM deals_created
  UNION DISTINCT SELECT user_id, activity_date FROM deals_won
  UNION DISTINCT SELECT user_id, activity_date FROM calls
  UNION DISTINCT SELECT user_id, activity_date FROM meetings
  UNION DISTINCT SELECT user_id, activity_date FROM tasks
  UNION DISTINCT SELECT user_id, activity_date FROM oacts
  UNION DISTINCT SELECT user_id, activity_date FROM presence
)

SELECT
  k.activity_date,
  k.user_id,
  u.full_name,
  u.email,
  u.role,
  u.profile,
  u.status,
  u.is_online                                   AS is_online_now,
  ROUND(COALESCE(w.working_hours, 0), 2)        AS working_hours,
  w.work_start,
  w.work_end,
  ROUND(COALESCE(TIMESTAMP_DIFF(w.work_end, w.work_start, SECOND) / 3600.0, 0), 2) AS work_span_hours,
  ROUND(COALESCE(TIMESTAMP_DIFF(w.work_end, w.work_start, SECOND) / 3600.0 - w.working_hours, 0), 2) AS break_hours,
  COALESCE(w.work_sessions, 0)                  AS work_sessions,
  ROUND(COALESCE(o.login_hours, 0), 4)          AS login_hours,
  COALESCE(o.online_polls, 0)                   AS online_polls,
  COALESCE(o.total_polls, 0)                    AS total_polls,
  o.first_seen_online,
  o.last_seen_online,
  COALESCE(p.active_hours, 0)                   AS active_hours,
  p.first_activity,
  p.last_activity,
  COALESCE(dc.deals_created, 0)                 AS deals_created,
  COALESCE(dw.won_deals, 0)                     AS won_deals,
  COALESCE(dw.won_value, 0)                     AS won_value,
  COALESCE(c.calls, 0)                          AS calls,
  ROUND(COALESCE(c.talk_min, 0), 2)             AS talk_min,
  COALESCE(m.meetings, 0)                       AS meetings,
  COALESCE(t.tasks, 0)                          AS tasks,
  COALESCE(a.online_acts, 0)                    AS online_acts,
  CURRENT_TIMESTAMP()                           AS built_at
FROM keys k
CROSS JOIN today
JOIN `lucirajewelry-prod.zoho_crm.crm_users` u ON u.user_id = k.user_id   -- same population as dashboard
LEFT JOIN online        o  ON o.user_id  = k.user_id AND o.activity_date  = k.activity_date
LEFT JOIN work          w  ON w.user_id  = k.user_id AND w.activity_date  = k.activity_date
LEFT JOIN presence      p  ON p.user_id  = k.user_id AND p.activity_date  = k.activity_date
LEFT JOIN deals_created dc ON dc.user_id = k.user_id AND dc.activity_date = k.activity_date
LEFT JOIN deals_won     dw ON dw.user_id = k.user_id AND dw.activity_date = k.activity_date
LEFT JOIN calls         c  ON c.user_id  = k.user_id AND c.activity_date  = k.activity_date
LEFT JOIN meetings      m  ON m.user_id  = k.user_id AND m.activity_date  = k.activity_date
LEFT JOIN tasks         t  ON t.user_id  = k.user_id AND t.activity_date  = k.activity_date
LEFT JOIN oacts         a  ON a.user_id  = k.user_id AND a.activity_date  = k.activity_date
WHERE k.activity_date IS NOT NULL
  AND k.activity_date <= today.d    -- drop future-dated meetings
  -- Zoho keeps old/deleted accounts of the same person (e.g. Farha Ansari has 3
  -- user_ids, 2 deleted). The poller snapshots them as offline every 30 min, which
  -- created all-zero rows. Keep a row only if it has some online time or activity.
  AND (COALESCE(o.online_polls, 0) > 0 OR p.user_id IS NOT NULL OR dc.user_id IS NOT NULL
       OR dw.user_id IS NOT NULL OR c.user_id IS NOT NULL OR m.user_id IS NOT NULL
       OR t.user_id IS NOT NULL OR a.user_id IS NOT NULL);
