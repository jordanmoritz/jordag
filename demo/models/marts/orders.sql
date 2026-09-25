with payments as (
    select
        order_id,
        sum(amount) as amount,
        sum(case when payment_method = 'credit_card' then amount else 0 end) as credit_card_amount
    from {{ ref('stg_payments') }}
    group by 1
)

select
    o.order_id,
    o.customer_id,
    o.order_date,
    o.status,
    coalesce(p.amount, 0) as amount,
    coalesce(p.credit_card_amount, 0) as credit_card_amount
from {{ ref('stg_orders') }} as o
left join payments as p using (order_id)
