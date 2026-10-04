# Appwrite Books schema update

In Appwrite, a table **attribute** is a column. Make these changes in the Appwrite Console before deploying the updated `keepflip-books` Function.

## Open the table

1. Open the KeepFlip project in the Appwrite Console.
2. Open **Databases** and select the **KeepFlip** database.
3. Open **Tables** and select **Book Transactions** (`book_transactions`).

The screenshots show the correct table. The two monetary columns below belong on this existing table; they are not a new table.

## Add the two optional integer columns

On the **Columns** tab, choose **Create column** once for each row below. Turn **Required** off and leave **Array** off for both.

| Key | Type | Required | Array | Meaning |
| --- | --- | --- | --- | --- |
| `costCents` | Integer | Off | Off | Known item cost moved to COGS by a sale or removed by a write-off. Zero means known zero cost; absent means unknown. |
| `shippingCostCents` | Integer | Off | Off | Direct shipping recorded on a sale. Zero means confirmed free shipping; absent means no shipping amount was recorded on that sale. |

Use whole cents. For example, `$3.25` is `325`. The Function writes these fields only when it has a value, so they must remain optional.

## Update existing columns

Use the row menu (`…`) on each existing column and choose **Update column**. Keep the current type and other settings; update only the values below.

| Existing key | Current setting shown | Update to | Why |
| --- | --- | --- | --- |
| `orderId` | String, size 36 | String, size 180 | The Books Function accepts order IDs up to 180 characters so a sale and its shipping label can retain the same full ID. |
| `payoutId` | String, size 36 | String, size 180 | The Books Function accepts external payout IDs up to 180 characters. |
| `externalKey` | String, size 100 | String, size 255 | Imported and reviewed transaction keys can be up to 255 characters. |

## Add the new enum choices

Use the row menu (`…`) and **Update column** for each enum. Preserve every existing element and add only the listed values. Leave **Required** on and **Array** off.

| Key | Add these elements |
| --- | --- |
| `eventType` | `inventory_write_off`, `inventory_value_adjustment` |
| `source` | `cost_reconciliation` |

Your current `eventType` and `source` lists already contain the other values used by Books. These additions let the Function save inventory write-offs, inventory value adjustments, and confirmed sale-cost reviews.

## Add the order lookup index

The supplied **Indexes** screenshot shows no index containing `orderId`. On the **Indexes** tab, choose **Create index** and create:

- **Key:** `ownerId_orderId_index`
- **Type:** Key
- **Columns:** `ownerId` ascending, then `orderId` ascending

Wait until its status is **Available**. The Function uses both columns to match a shipping-label expense to its sale for the same owner.

## Cost flow and year-end adjustments

KeepFlip uses per-row average cost: each saved inventory row is its own cost pool. Partial sales or write-offs remove a proportional share of that row's remaining cost; the last units take any rounding remainder. Add units with different actual costs as separate rows.

For a year-end inventory review, use **Inventory value adjustment** in Advanced Books for each affected row, enter the count date and new total value of its remaining units, and record the reason or valuation evidence. The current flow records decreases only. **Inventory write-off** removes the selected quantity and its remaining average cost, records the reason, and updates the inventory row in the same Books transaction.

## Deploy order

1. Add the two columns, update the two string sizes and enum choices, and create the order lookup index.
2. Wait for the index and new columns to show **Available** in Appwrite.
3. Deploy the `keepflip-books` Function.
4. Deploy the client update that exposes sale shipping, write-off, and value-adjustment flows.

Existing transactions are not backfilled with an assumed shipping amount. A sale shows complete realized profit only when its cost and shipping are known. Use zero when shipping was genuinely free, or link a separate shipping-label entry with the same order number.
