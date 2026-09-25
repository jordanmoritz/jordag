-- jordag usage: per object, who read it and under which role (queries in the last 7/30/90 days), which Metabase
-- dashboards/cards, and who rebuilt it (DML or DDL). Keys are ROLE:USER. __DAYS__ and __NAMES__ come from jordag.py.
with ah as (
    select query_id, query_start_time as t, user_name, direct_objects_accessed, objects_modified, object_modified_by_ddl
    from snowflake.account_usage.access_history
    where query_start_time >= dateadd(day, -__DAYS__, current_timestamp())
),
names (obj) as (select column1 from values __NAMES__),
reads as (
    select a.query_id, a.t, a.user_name, upper(o.value:"objectName"::string) as obj
    from ah a, lateral flatten(input => a.direct_objects_accessed) o
    where upper(o.value:"objectName"::string) in (select obj from names)
),
writes as (
    select a.query_id, a.t, a.user_name, upper(o.value:"objectName"::string) as obj
    from ah a, lateral flatten(input => a.objects_modified) o
    where upper(o.value:"objectName"::string) in (select obj from names)
    union all
    select query_id, t, user_name, upper(object_modified_by_ddl:"objectName"::string)
    from ah
    where upper(object_modified_by_ddl:"objectName"::string) in (select obj from names)
),
qh as (  -- ACCESS_HISTORY has no role; QUERY_HISTORY does, plus the Metabase remark with dashboard/card ids
    select
        query_id,
        role_name,
        iff(mb, regexp_substr(query_text, '"dashboardId": *([0-9]+)', 1, 1, 'e'), null) as dash,
        iff(mb, regexp_substr(query_text, '"cardId": *([0-9]+)', 1, 1, 'e'), null) as card,
        -- Metabase's column fingerprinting samples every table; it isn't real use
        mb and regexp_instr(query_text, 'SUBSTRING[(].*,[[:space:]]*1,[[:space:]]*[0-9]{4,}[)]', 1, 1, 0, 'is') > 0 as fingerprint
    from (
        select query_id, role_name, query_text, query_text ilike '%"client":"metabase"%' as mb
        from snowflake.account_usage.query_history
        where start_time >= dateadd(day, -__DAYS__, current_timestamp())
          and query_id in (select query_id from reads union select query_id from writes)
    )
),
r as (
    select reads.*, coalesce(q.role_name, '?') || ':' || reads.user_name as who, q.dash, q.card
    from reads left join qh q using (query_id)
    where not coalesce(q.fingerprint, false)
),
w as (
    select writes.*, coalesce(q.role_name, '?') || ':' || writes.user_name as who
    from writes left join qh q using (query_id)
)
select 'read' as kind, obj, who as key,
    count(distinct iff(t >= dateadd(day, -7, current_timestamp()), query_id, null)) as q7,
    count(distinct iff(t >= dateadd(day, -30, current_timestamp()), query_id, null)) as q30,
    count(distinct query_id) as q90, max(t) as last
from r group by 1, 2, 3
union all
select 'dash', obj, dash,
    count(distinct iff(t >= dateadd(day, -7, current_timestamp()), query_id, null)),
    count(distinct iff(t >= dateadd(day, -30, current_timestamp()), query_id, null)),
    count(distinct query_id), max(t)
from r where dash is not null group by 1, 2, 3
union all
select 'card', obj, card,
    count(distinct iff(t >= dateadd(day, -7, current_timestamp()), query_id, null)),
    count(distinct iff(t >= dateadd(day, -30, current_timestamp()), query_id, null)),
    count(distinct query_id), max(t)
from r where card is not null and dash is null group by 1, 2, 3
union all
select 'write', obj, who,
    count(distinct iff(t >= dateadd(day, -7, current_timestamp()), query_id, null)),
    count(distinct iff(t >= dateadd(day, -30, current_timestamp()), query_id, null)),
    count(distinct query_id), max(t)
from w group by 1, 2, 3
