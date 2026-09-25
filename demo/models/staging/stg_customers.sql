select
    id as customer_id,
    first_name,
    last_name,
    lower(email) as email
from {{ source('shop', 'raw_customers') }}
