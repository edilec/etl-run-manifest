-- orders-normalise 3.2.0
-- Joins the raw order rows to their customer region and drops cancelled rows.
SELECT o.order_ref,
       o.customer_ref,
       c.region,
       o.quantity,
       o.amount_cents
FROM orders_raw AS o
JOIN customers_raw AS c ON c.customer_ref = o.customer_ref
WHERE o.status <> 'cancelled'
ORDER BY o.order_ref;
