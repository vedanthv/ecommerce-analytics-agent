# Demographic Analysis Guide

## Why Demographic Queries Were Going to RAG

Your system was routing demographic queries to RAG instead of SQL because:
1. **Incomplete prompt rules** - The classifier prompt didn't explicitly mention demographic analysis as SQL-only
2. **Weak detection logic** - `shouldForceSqlAnalytics()` didn't include "demographic" keywords
3. **Missing examples** - The classifier had no examples of demographic queries to guide the LLM

## What Changed

✅ **Updated classifier prompt** to explicitly call out demographic queries as SQL-only  
✅ **Enhanced detection function** to catch demographic keywords like: demographic, segmentation, segment, cohort, categorical, distribution, profiling  
✅ **Added example queries** to guide the classifier

## Demographic Analysis Query Patterns

Your orders table has rich demographic data. Here are the key demographic dimensions:

### Geographic Demographics
```sql
-- Orders by region
SELECT region, COUNT(*) as order_count, SUM(order_amount) as total_amount
FROM customer_suppport_agent.raw.orders
GROUP BY region
ORDER BY order_count DESC;

-- Orders by city (top 20)
SELECT city, region, COUNT(*) as order_count, SUM(order_amount) as total_amount
FROM customer_suppport_agent.raw.orders
GROUP BY city, region
ORDER BY order_count DESC
LIMIT 20;
```

### Device & Technology Demographics
```sql
-- Orders by device type
SELECT device_type, COUNT(*) as orders, ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as pct
FROM customer_suppport_agent.raw.orders
GROUP BY device_type
ORDER BY orders DESC;

-- Orders by device x browser
SELECT device_type, browser, COUNT(*) as orders
FROM customer_suppport_agent.raw.orders
GROUP BY device_type, browser
ORDER BY orders DESC;
```

### Payment Method Demographics
```sql
-- Orders segmented by payment method
SELECT payment_method, COUNT(*) as order_count, SUM(order_amount) as total_amount, 
       AVG(order_amount) as avg_amount, payment_status
FROM customer_suppport_agent.raw.orders
GROUP BY payment_method, payment_status
ORDER BY order_count DESC;
```

### Order Channel Demographics
```sql
-- Orders by channel
SELECT order_channel, COUNT(*) as order_count, SUM(order_amount) as revenue
FROM customer_suppport_agent.raw.orders
GROUP BY order_channel
ORDER BY revenue DESC;

-- Channel vs fulfillment type
SELECT order_channel, fulfillment_type, COUNT(*) as orders, AVG(order_amount) as avg_order
FROM customer_suppport_agent.raw.orders
GROUP BY order_channel, fulfillment_type
ORDER BY orders DESC;
```

### Product Demographics
```sql
-- Orders by product
SELECT product_id, COUNT(*) as order_count, SUM(quantity) as units_sold,
       SUM(order_amount) as revenue
FROM customer_suppport_agent.raw.orders
GROUP BY product_id
ORDER BY revenue DESC
LIMIT 20;

-- Product by region
SELECT product_id, region, COUNT(*) as orders, SUM(order_amount) as revenue
FROM customer_suppport_agent.raw.orders
GROUP BY product_id, region
ORDER BY revenue DESC
LIMIT 30;
```

### Multi-Dimensional Demographics
```sql
-- Rich demographic breakdown
SELECT region, city, device_type, order_channel, 
       COUNT(*) as order_count,
       SUM(order_amount) as total_revenue,
       AVG(order_amount) as avg_order,
       SUM(CASE WHEN order_status = 'completed' THEN 1 ELSE 0 END) as completed_orders
FROM customer_suppport_agent.raw.orders
GROUP BY region, city, device_type, order_channel
HAVING COUNT(*) > 5
ORDER BY total_revenue DESC;
```

## Effective Demographic Query Formulations

### Good Query Examples (Will Now Route to SQL)
- ✅ "Give me demographic analysis of all orders"
- ✅ "Show order distribution by region and payment method"
- ✅ "Break down customers by city and device type"
- ✅ "Segment orders by order_channel and order_status"
- ✅ "Show demographic breakdown of orders"
- ✅ "Analyze orders demographic by region"
- ✅ "What's the distribution of orders across regions?"
- ✅ "Give me a demographic profile of orders"

### Avoid Vague Queries (May Still Route to RAG)
- ❌ "Tell me about the orders" (too vague)
- ❌ "What happened with orders?" (no clear intent)
- ❌ "Orders analysis" (ambiguous without specific dimension)

### Best Practices for Reliable SQL Routing
1. **Include demographic keywords**: Use "demographic", "segment", "breakdown", "distribution", "segmentation"
2. **Be specific about dimensions**: Name the fields you want to analyze by (region, device_type, payment_method, etc.)
3. **Include aggregation intent**: Use "show", "analyze", "breakdown", "compare"
4. **Scope the data clearly**: Reference "all orders", "overall", "across", or specific periods

## How the System Now Works

```
User Query: "Give me demographic analysis of all the orders"
                    ↓
         Classifier & Detection Functions
                    ↓
    shouldForceSqlAnalytics() checks:
    - hasDomainIntent: ✓ (contains "orders")
    - hasDemographicIntent: ✓ (contains "demographic")
    - hasAnalyticVerb: ✓ (contains "analysis")
                    ↓
         ✅ Forces SQL Mode
                    ↓
    Classifier generates proper GROUP BY query
                    ↓
         Databricks executes SQL
                    ↓
    Results summarized by LLM + table returned
```

## Troubleshooting

If a query still goes to RAG:
1. **Check keywords** - Include demographic-related terms from the detection function
2. **Add scope** - Use "all", "overall", "entire" to trigger whole-dataset scope
3. **Be explicit** - Name the columns you want grouped/segmented by
4. **Check domain** - Ensure it mentions orders, customers, payments, delivery, etc.

## Common Demographic Questions & How to Ask Them

| Question | Good Phrasing | Keywords to Include |
|----------|---------------|-------------------|
| Regional analysis | "What's the demographic breakdown by region?" | demographic, breakdown, region |
| Device types | "Segment orders by device type" | segment, device |
| Payment methods | "Analyze order distribution by payment method" | analyze, distribution, payment|
| Channels | "Which order channels have highest volume?" | channel, volume, analysis |
| Multi-dimensional | "Give me demographic profile: region x channel x device" | demographic, profile |

## Testing Your Changes

Test these queries in the chat to verify they now route to SQL:

```
1. "Give me demographic analysis of all the orders"
2. "Show order demographic breakdown by region and payment method"
3. "Analyze orders distribution across cities"
4. "Segment orders by device type and fulfillment type"
5. "Create demographic profile of all orders: region x channel x device"
```

All should now show `mode: "SQL"` in the response and return structured tables.
