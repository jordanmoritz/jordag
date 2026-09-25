with orders as (
    select
        customer_id,
        min(order_date) as first_order,
        max(order_date) as most_recent_order,
        count(*) as number_of_orders,
        sum(amount) as lifetime_value
    from {{ ref('orders') }}
    group by 1
)

select
    c.customer_id,
    c.first_name,
    c.last_name,
    o.first_order,
    o.most_recent_order,
    coalesce(o.number_of_orders, 0) as number_of_orders,
    coalesce(o.lifetime_value, 0) as lifetime_value
from {{ ref('stg_customers') }} as c
left join orders as o using (customer_id)
