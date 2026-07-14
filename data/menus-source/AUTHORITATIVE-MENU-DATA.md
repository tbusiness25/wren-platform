# LADN Authoritative Menu Data

This file contains the actual current menus and allergen reference at Little Angels Day Nursery as of 2025/26. Use this as the seed for the menus database — these are real recipes that have been in service.

**Allergen code system** (LADN's own — note slight variation from EU14):
- **G** = Gluten (cereals)
- **C** = Crustaceans
- **E** = Eggs
- **F** = Fish
- **P** = Peanuts
- **S** = Soyabeans
- **M** = Milk (dairy)
- **N** = Tree nuts
- **CY** = Celery
- **MS** = Mustard
- **SS** = Sesame
- **SL** = Sulphites (E220-228)
- **L** = Lupin
- **ML** = Molluscs

Map to UK 14 statutory allergens internally (database column `allergens text[]` should use full names: gluten, crustaceans, eggs, fish, peanuts, soyabeans, milk, tree_nuts, celery, mustard, sesame, sulphites, lupin, molluscs). Display as the LADN code on UI for staff continuity.

## SUMMER MENU (rotates every 4 weeks)

### Summer Week 1
- MON: Fish fingers, chips, sweetcorn, peas | Yoghurt and fruit ice lollies — allergens: G, F, M
- TUE: Pasta in tomato sauce with peppers, sweetcorn, mozzarella | Fromage frais — allergens: G, M
- WED: Sausage, mash, green beans | Greek yoghurt and berries — allergens: M
- THU: Macaroni cheese with leek and butternut squash | Bananas with custard — allergens: G, M, E
- FRI: Mixed bean chilli con carne with rice and sour cream | Butterscotch whip — allergens: M

### Summer Week 2
- MON: Couscous with tomatoes, chickpeas, courgette | Yoghurt and fruit ice lollies — allergens: G, M
- TUE: Sausage and noodles in tomato sauce with broccoli | Strawberry whip — allergens: G, M
- WED: BBQ Quorn with rice and peas | Bananas with custard — allergens: E, M
- THU: Bean fajita mix and mash | Fromage frais — allergens: M
- FRI: Salmon cheesy pasta | Greek yoghurt with berries — allergens: F, G, M

### Summer Week 3
- MON: Quorn curry with tomatoes, spinach, rice | Yoghurt and fruit ice lollies — allergens: E, M
- TUE: Mixed bean medley couscous | Stewed apples with custard — allergens: G, M
- WED: Veggie fingers with mash and beans | Butterscotch whip — allergens: G, M
- THU: Sweet and sour Quorn with noodles | Greek yoghurt with fruit salad — allergens: G, E, M
- FRI: Spaghetti bolognese (lamb mince) with parmesan | Fromage frais — allergens: G, M, E

### Summer Week 4
- MON: Vegetable curry with rice | Yoghurt and fruit ice lollies — allergens: M
- TUE: Tuna tomato pasta | Bananas with custard — allergens: F, G, M, E
- WED: Sausage and butterbean casserole with mash | Fromage frais — allergens: G, M
- THU: Vegetable chow mein with noodles | Greek yoghurt with berries — allergens: G, M
- FRI: Spaghetti meatballs with parmesan | Strawberry whip — allergens: G, M

## WINTER MENU 2025 (rotates every 4 weeks)

### Winter Week 1
- MON: Vegetable fingers, chips, baked beans | Greek yoghurt with honey — allergens: G, M
- TUE: Shepherds pie (lamb mince) and peas | Semolina with cinnamon sprinkles — allergens: G, M
- WED: Sweet potato and lentil dhal with rice | Butterscotch whip — allergens: M
- THU: Sweet and sour chicken (Quorn), Chinese vegetables, noodles | Greek yoghurt with raspberries — allergens: CY, E, M
- FRI: Fish pie with broccoli and carrots | Jelly fruit salad — allergens: F, M

### Winter Week 2
- MON: Sweet potato, butternut, chickpea & spinach tagine, couscous | Strawberry whip — allergens: G, M
- TUE: Barbecue chicken (Quorn), rice, peas | Berry pastries and custard — allergens: CY, G, E, M
- WED: Salmon and pasta bake with broccoli | Rice pudding with banana | allergens: F, G, M
- THU: Mediterranean lamb casserole with swede, carrot, potato mash | Greek yoghurt with stewed apples — allergens: M
- FRI: Mediterranean vegetable noodles with mushrooms | Fruit salad — allergens: G, E, M

### Winter Week 3
- MON: Chicken (Quorn), tomato and spinach curry with rice | Greek yoghurt with strawberries — allergens: G, CY, E, M
- TUE: Fish fingers, mash, peas | Butterscotch whip — allergens: F, M, G
- WED: Tuna macaroni and sweetcorn cheese | Jelly fruit salad — allergens: F, G, M
- THU: Five bean chilli with couscous | Semolina with blackberries — allergens: G, M
- FRI: Spaghetti bolognese (beef mince) | Banana cake traybake — allergens: G, E, M

### Winter Week 4
- MON: Spicy chickpea, tomato, courgette couscous | Greek yoghurt with honey — allergens: G, M
- TUE: Lentil and vegetable stew with dumplings and mash | Strawberry whip — allergens: G, M
- WED: Salmon pasta bake with peas | Fruit salad — allergens: F, G, M
- THU: Beef lasagne | Rice pudding with berries — allergens: M
- FRI: Barbecue chicken (Quorn), rice, peas | Greek yoghurt with stewed rhubarb — allergens: CY, G, M

## Tea/Snack standard items with allergens
| Item | Allergens |
|---|---|
| Bernard Matthews turkey ham | M |
| Tuna and sweetcorn deli filler | F, E |
| Houmous | SS |
| Mini egg bites | G, E, MS |
| Cooked pork cocktail sausages | G |
| Wholemeal bread | G, S |
| Pitta bread (white, wholemeal) | G, S |
| Plain tortilla wraps | G |
| Wholemeal tortilla | G |
| Garlic & coriander naan | G, M |
| Crumpets | G |
| Scotch pancakes | G, M, E |
| Fruit loaf | G, S |
| Margherita pizza | G, M |
| McVitie's Cheddars cheese biscuits | G, M |
| Mini breadsticks | G |
| Cheese savouries | G, M |
| Dried apricots | SL |
| Alpro desserts and yoghurts | S |
| Organix Goodies animal biscuits | G |
| Organix Goodies gingerbread men | G |

## No-allergen items
- Yeast extract (Marmite)
- All varieties of Organix finger foods

## Notes for migration
- Each menu item is a meal_type=lunch with two parts: main + dessert. Store as ONE recipe with name "Main + Dessert" e.g. "Fish fingers, chips, sweetcorn, peas + Yoghurt and fruit ice lollies", OR split into two (preferred).
- Quorn is used as chicken substitute throughout (vegetarian-friendly) — always note in description.
- Recipe age_groups should be ['toddler', 'preschool'] for these — the baby room has separate purée/finger food menu (not in this dataset, generate stubs to be filled in later).
- Tag rotation: every recipe gets tag 'summer-rotation-week-N' or 'winter-rotation-week-N' so the planner can auto-fill the next 4 weeks.
- Source documents are available at:
  - /home/toby/wren/data/menus-source/Winter_Menu_2025.docx
  - /home/toby/wren/data/menus-source/Summer_Menu_2024.docx
  - /home/toby/wren/data/menus-source/Guide_to_allergens.docx
