Fix product matching in the products route.

LT orders (bloom_lt store) - parse from product name in line_items:
SIZE: regex /ø(\d+)cm/i or /(\d+)[xX×](\d+)/ from name
MOSS TYPE:
- contains "kupstinės" OR "kupstin" = ball moss
- everything else = mix (default, no keyword needed)

DK orders (mossbloom_dk store) - size from meta_data key "pa_stoerrelse":
Values like "o80cm" -> convert to ø80cm (replace leading o with ø)
MOSS TYPE from product name:
- contains "pude mos" OR "pudemos" OR "pude-mos" = ball moss
- contains "Trio" OR "trio" = trio bundle  
- everything else = mix (default)

DE orders (mossbloom_de) - skip for now, no products defined

Match to products table by: size + moss_type + store
Return units_sold and revenue_total per product.