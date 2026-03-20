# Fixed selling price per unit (€) – from product_sku_price.csv (sale price, else regular).
# Regenerate with: python3 update_prices_from_csv.py
prices = {
    "22011": 23.5,  # Cherax – License Key - Standard
    "22012": 46.0,  # Cherax – License Key - Premium
    "22013": 23.5,  # Cherax – License Key - Standard to Premium Upgrade
    "4410": 5.95,  # Midnight - CS2 - 30 Days
    "4510": 4.9,  # Midnight - CS 1.6 - 30 Days
    "3310": 6.1,  # Midnight - GTA - 30 Days FSL
    "3320": 18.7,  # Midnight - GTA - Lifetime FSL
    "3610": 11.8,  # Stand – GTA - Basic
    "3620": 24.45,  # Stand – GTA - Regular
    "3630": 48.0,  # Stand – GTA - Ultimate
    "3640": 11.8,  # Stand – GTA - Basic to Regular Upgrade
    "3650": 24.5,  # Stand – GTA - Regular to Ultimate Upgrade
    "3660": 36.8,  # Stand – GTA - Basic to Ultimate Upgrade
    "5310": 2.99,  # MemeSense - CS2 - 14 Days
    "5320": 4.3,  # MemeSense - CS2 - 31 Days
    "5330": 10.2,  # MemeSense - CS2 - 90 Days
    "5340": 17.0,  # MemeSense - CS2 - 180 Days
    "5210": 16.15,  # Atlas – GTA - Enhanced
    "5220": 20.4,  # Atlas – GTA - VIP 30 Days Upgrade
    "4310": 25.8,  # Lexis - GTA - 1 Month
    "4320": 60.2,  # Lexis - GTA - 3 Month
    "4330": 120.0,  # Lexis - GTA - Lifetime
    "3410": 16.25,  # Fortitude - RDR2 - 30 days
    "3420": 52.4,  # Fortitude - RDR2 - Lifetime
    "4710": 5.8,  # 0xCheats – GTA Legacy & Enhance - 7 days Legacy
    "4720": 11.6,  # 0xCheats – GTA Legacy & Enhance - 30 days Legacy & Enhanced
    "9301": 4.4,  # Predator CS2 - 1 Month
    "9302": 12.0,  # Predator CS2 - 3 Months
    "9304": 1.5,  # Predator CS2 - 1 Day
    "9305": 3.5,  # Predator CS2 - 1 Week
    "9401": 7.53,  # Raiden - GTA - Regular
    "9402": 12.24,  # Raiden - GTA - Ultimate
    "4920": 57.5,  # Infamous – GTA - Enhanced Full Plus
    "4910": 23.5,  # Infamous – GTA - Legacy Full
    "4940": 45.8,  # Infamous – GTA - Legacy Full Plus
    "2801": 9.0,  # Hares - License Key - Basic
    "3510": 18.5,  # Rebound - GTA - Premium
    "4220": 17.0,  # Phaze Mod Menu - 1 Month
    "4230": 42.0,  # Phaze Mod Menu - Lifetime
    "5410": 1.13,  # Nixware - CS2 - 1 Day
    "5420": 3.02,  # Nixware - CS2 - 14 Days
    "5430": 4.75,  # Nixware - CS2 - 30 Days
    "5440": 7.86,  # Nixware - CS2 - 60 Days
    "5450": 11.28,  # Nixware - CS2 - 90 Days
    "5460": 1.02,  # Nixware - CS2 - HWID Reset
    "3000-1": 27.75,  # Rebound - GTA VIP License Key
    "178": 35.0,  # Fragment – License Key
    "2110": 15.0,  # X-Force – GTA - Essential
    "2120": 25.0,  # X-Force – GTA - Ace Activation + 7 days
    "2130": 25.0,  # X-Force – GTA - Ace 30 days Extension
    "2900": 45.0,  # Fortitude - GTA - Lifetime License Key
    "2901": 17.0,  # Fortitude - GTA - 30 Days License Key
    "3000": 18.5,  # Rebound - GTA Premium License Key
    "3010": 11.1,  # Rebound - GTA VIP Upgrade Key
    "3910": 7.53,  # Predator Deadlock - 1 Week
    "3920": 16.03,  # Predator Deadlock - 1 Month
    "3930": 33.0,  # Predator Deadlock - 3 Months
    "3940": 54.7,  # Predator Deadlock - 6 Months
    "3950": 83.0,  # Predator Deadlock - 1 Year
    "4010": 9.0,  # redENGINE FiveM Lua Executor - 1 Week
    "4020": 17.0,  # redENGINE FiveM Lua Executor - 1 Month
    "4030": 42.0,  # redENGINE FiveM Lua Executor - Lifetime
    "4110": 7.0,  # redENGINE FiveM Spoofer - 1 Week
    "4120": 13.2,  # redENGINE FiveM Spoofer - 1 Month
    "4210": 8.87,  # Phaze Mod Menu - 1 Week
    "4610": 9.3,  # Lexis - Apex Legends - 3 Days
    "4620": 14.6,  # Lexis - Apex Legends - 1 Week
    "4630": 24.3,  # Lexis - Apex Legends - 1 Month
    "4640": 44.3,  # Lexis - Apex Legends - 3 Months
    "4650": 140.0,  # Lexis - Apex Legends - Lifetime
    "4730": 23.2,  # 0xCheats – GTA Legacy & Enhance - 90 days Legacy & Enhanced
    "4810": 2.8,  # Predator Marvel Rivals - 1 Day
    "4820": 7.5,  # Predator Marvel Rivals - 1 Week
    "4830": 16.0,  # Predator Marvel Rivals - 1 Month
    "4840": 33.0,  # Predator Marvel Rivals - 3 Months
    "4850": 55.0,  # Predator Marvel Rivals - 6 Months
    "4860": 83.0,  # Predator Marvel Rivals - 1 Year
    "4930": 70.0,  # Infamous – GTA - Tester Legacy & Enhanced
    "5010": 41.0,  # Infamous – FiveM - Full
    "5110": 23.5,  # Infamous – RDR2 - Full
    "5510": 8.8,  # Kernaim - CS2 - 1 Week
    "5520": 14.7,  # Kernaim - CS2 - 1 Month
    "5530": 38.9,  # Kernaim - CS2 - 3 Months
    "5610": 17.65,  # Kernaim - Apex - 1 Week
    "5620": 41.0,  # Kernaim - Apex - 1 Month
    "5630": 81.5,  # Kernaim - Apex - 3 Months
    "5710": 19.99,  # Kernaim - ARC Raiders - 1 Week
    "5720": 39.99,  # Kernaim - ARC Raiders - 1 Month
    "5730": 79.99,  # Kernaim - ARC Raiders - 3 Months
    "5810": 19.99,  # Kernaim - Black Ops 7 - 1 Week
    "5820": 29.99,  # Kernaim - Black Ops 7 - 1 Month
    "5830": 69.99,  # Kernaim - Black Ops 7 - 3 Months
    "5910": 19.99,  # Kernaim - Black Ops 6 - 1 Week
    "5920": 29.99,  # Kernaim - Black Ops 6 - 1 Month
    "5930": 69.99,  # Kernaim - Black Ops 6 - 3 Months
    "6010": 29.99,  # Kernaim - Battlefield 6 - 1 Week
    "6020": 29.99,  # Kernaim - Battlefield 6 - 1 Month
    "6030": 69.99,  # Kernaim - Battlefield 6 - 3 Months
    "6110": 29.99,  # Kernaim - Rust - 1 Week
    "6120": 29.99,  # Kernaim - Rust - 1 Month
    "6130": 69.99,  # Kernaim - Rust - 3 Months
    "6210": 29.99,  # Kernaim - Escape from Tarkov - 1 Week
    "6220": 29.99,  # Kernaim - Escape from Tarkov - 1 Month
    "6230": 69.99,  # Kernaim - Escape from Tarkov - 3 Months
    "6310": 29.99,  # Kernaim - DayZ - 1 Week
    "6320": 29.99,  # Kernaim - DayZ - 1 Month
    "6330": 69.99,  # Kernaim - DayZ - 3 Months
    "6410": 19.99,  # Kernaim - Modern Warfare III - 1 Week
    "6420": 29.99,  # Kernaim - Modern Warfare III - 1 Month
    "6430": 69.99,  # Kernaim - Modern Warfare III - 3 Months
    "6510": 4.3,  # Fecurity – COD: BO7 / BO6 / WZ / MW3 / MW2 / MW19 - 1 Day
    "6520": 6.9,  # Fecurity – COD: BO7 / BO6 / WZ / MW3 / MW2 / MW19 - 3 Days
    "6530": 11.22,  # Fecurity – COD: BO7 / BO6 / WZ / MW3 / MW2 / MW19 - 1 Week
    "6540": 25.9,  # Fecurity – COD: BO7 / BO6 / WZ / MW3 / MW2 / MW19 - 1 Month
    "6550": 56.1,  # Fecurity – COD: BO7 / BO6 / WZ / MW3 / MW2 / MW19 - 3 Months
    "6610": 6.9,  # Fecurity – Battlefield 6 / 5 / 1 / 2042 - 1 Day
    "6620": 30.2,  # Fecurity – Battlefield 6 / 5 / 1 / 2042 - 1 Week
    "6630": 60.45,  # Fecurity – Battlefield 6 / 5 / 1 / 2042 - 1 Month
    "6710": 7.55,  # Fecurity – CS2 - 1 Day
    "6720": 12.95,  # Fecurity – CS2 - 14 Days
    "6730": 25.9,  # Fecurity – CS2 - 1 Month
    "6810": 4.3,  # Fecurity – Arc Raiders - 1 Day
    "6820": 25.75,  # Fecurity – Arc Raiders - 1 Week
    "6830": 55.8,  # Fecurity – Arc Raiders - 1 Month
    "6910": 13.99,  # Ethereal – GTA - Legacy, 1 Month
    "6920": 33.99,  # Ethereal – GTA - Legacy, Lifetime
    "6930": 14.99,  # Ethereal – GTA - Enhanced, 1 Month
    "6940": 39.99,  # Ethereal – GTA - Enhanced, Lifetime
    "7010": 10.0,  # Ethereal – RDR2 - 1 Month
    "7020": 25.0,  # Ethereal – RDR2 - Lifetime
    "7110": 17.0,  # Scooby – GTA - Premium
    "7210": 8.5,  # Rift – FiveM - 1 Week
    "7220": 17.0,  # Rift – FiveM - 1 Month
    "7230": 34.1,  # Rift – FiveM - Lifetime
    "7301": 6.0,  # Jupiter – Mod Menu - 30 days
    "7302": 12.0,  # Jupiter – Mod Menu - Lifetime
    "8401": 6.5,  # Rift – RDR2 - 7 days
    "8402": 17.5,  # Rift – RDR2 - 30 days
    "8403": 32.5,  # Rift – RDR2 - Lifetime
    "9303": 48.0,  # Predator CS2 - 1 Year
    "9306": 24.0,  # Predator CS2 - 6 Months
}
