"""Fill lat/lng for market_ports so nearest-port matching works."""
import asyncio

import asyncpg

COORDS = {
    # un_locode: (lat, lng)
    "USLAX": (33.7292, -118.2620),   # Los Angeles
    "USLGB": (33.7542, -118.2164),   # Long Beach
    "USOAK": (37.8044, -122.2712),   # Oakland
    "USSEA": (47.6062, -122.3321),   # Seattle
    "USTIW": (47.2529, -122.4443),   # Tacoma
    "USNYC": (40.7128, -74.0060),    # New York
    "USSAV": (32.0809, -81.0912),    # Savannah
    "USHOU": (29.7604, -95.3698),    # Houston
    "USMIA": (25.7617, -80.1918),    # Miami
    "CAVAN": (49.2827, -123.1207),   # Vancouver
    "CAMTR": (45.5019, -73.5674),    # Montreal
    "CAPRR": (54.3150, -130.3200),   # Prince Rupert
    "MXZLO": (19.0500, -104.3200),   # Manzanillo
    "MXVER": (19.1738, -96.1342),    # Veracruz
    "MXLZC": (17.9700, -102.2000),   # Lazaro Cardenas
    "DEHAM": (53.5511, 9.9937),      # Hamburg
    "DEBRV": (53.5396, 8.5809),      # Bremerhaven
    "DEWVN": (53.5170, 8.1180),      # Wilhelmshaven
    "NLRTM": (51.9225, 4.4792),      # Rotterdam
    "BEANR": (51.2194, 4.4025),      # Antwerp
    "BEZEE": (51.3500, 3.2000),      # Zeebrugge
    "FRLEH": (49.4944, 0.1079),      # Le Havre
    "FRMRS": (43.2965, 5.3698),      # Marseille
    "GBFXT": (51.9636, 1.3516),      # Felixstowe
    "GBSOU": (50.9097, -1.4044),     # Southampton
    "GBLGP": (51.5000, 0.5000),      # London Gateway
    "GBLIV": (53.4084, -2.9916),     # Liverpool
    "ESVLC": (39.4699, -0.3763),     # Valencia
    "ESBCN": (41.3851, 2.1734),      # Barcelona
    "ESALG": (36.1408, -5.4562),     # Algeciras
    "ESBIO": (43.2630, -2.9350),     # Bilbao
    "ITGOA": (44.4056, 8.9463),      # Genoa
    "ITTRS": (45.6495, 13.7768),     # Trieste
    "ITGIT": (38.4244, 15.8950),     # Gioia Tauro
    "ITSPE": (44.1024, 9.8200),      # La Spezia
    "PLGDN": (54.3520, 18.6466),     # Gdansk
    "PLGDY": (54.5189, 18.5305),     # Gdynia
    "SEGOT": (57.7089, 11.9746),     # Gothenburg
    "DKAAR": (56.1629, 10.2039),     # Aarhus
    "FIHEL": (60.1699, 24.9384),     # Helsinki
    "AUSYD": (-33.8688, 151.2093),   # Sydney
    "AUMEL": (-37.8136, 144.9631),   # Melbourne
    "AUBNE": (-27.4698, 153.0251),   # Brisbane
    "AUPER": (-31.9505, 115.8605),   # Fremantle/Perth
    "JPTYO": (35.6762, 139.6503),    # Tokyo
    "JPYOK": (35.4437, 139.6380),    # Yokohama
    "JPOSA": (34.6937, 135.5023),    # Osaka
    "JPUKB": (34.6901, 135.1955),    # Kobe
    "JPNGO": (35.1815, 136.9066),    # Nagoya
    "JPHKT": (33.5902, 130.4017),    # Hakata/Fukuoka
    "KRPUS": (35.1028, 129.0403),    # Busan
    "KRINC": (37.4563, 126.7052),    # Incheon
    "AEJEA": (25.0118, 55.0617),     # Jebel Ali
    "AEAUH": (24.4539, 54.3773),     # Abu Dhabi/Khalifa
    "SAJED": (21.4858, 39.1925),     # Jeddah
    "SADMM": (26.4344, 50.1033),     # Dammam
    "QAHMD": (25.3260, 51.5640),     # Hamad
    "KWSWK": (29.3600, 47.9500),     # Shuwaikh
    "OMSOH": (24.3643, 56.7430),     # Sohar
    "OMSLL": (17.0194, 54.0854),     # Salalah
    "ILHFA": (32.7940, 34.9896),     # Haifa
    "ILASH": (31.8044, 34.6553),     # Ashdod
    "TRIST": (41.0082, 28.9784),     # Istanbul
    "TRIZM": (38.4237, 27.1428),     # Izmir
    "TRMER": (36.8121, 34.6415),     # Mersin
    "INNSA1": (18.9490, 72.9520),    # Nhava Sheva
    "INMUN1": (22.8390, 69.7200),    # Mundra
    "INMAA": (13.0827, 80.2707),     # Chennai
    "INCCU": (22.5726, 88.3639),     # Kolkata
    "INCOK": (9.9312, 76.2673),      # Kochi
    "VNSGN": (10.8231, 106.6297),    # Ho Chi Minh/Cai Mep
    "VNHPH": (20.8449, 106.6881),    # Haiphong
    "THLCH": (13.0833, 100.8833),    # Laem Chabang
    "THBKK": (13.7563, 100.5018),    # Bangkok
    "MYPKG": (3.0000, 101.4000),     # Port Klang
    "MYPEN": (5.4141, 100.3288),     # Penang
    "MYJHB": (1.4716, 103.9077),     # Johor/Pasir Gudang
    "SGSIN": (1.2644, 103.8200),     # Singapore
    "IDJKT": (-6.2088, 106.8456),    # Jakarta
    "IDSUB": (-7.2575, 112.7521),    # Surabaya
    "IDBLW": (3.8000, 98.6800),      # Belawan
    "PHMNL": (14.5995, 120.9842),    # Manila
    "PHCEB": (10.3157, 123.8854),    # Cebu
    "BRSSZ": (-23.9618, -46.3322),   # Santos
    "BRRIO": (-22.9068, -43.1729),   # Rio de Janeiro
    "BRPNG": (-25.5163, -48.5225),   # Paranagua
    "ARBUE": (-34.6037, -58.3816),   # Buenos Aires
    "CLVAP": (-33.0472, -71.6127),   # Valparaiso
    "CLSAI": (-33.5940, -71.6070),   # San Antonio
    "PECLL": (-12.0464, -77.0428),   # Callao
    "COBUN": (3.8800, -77.0300),     # Buenaventura
    "PAPCO": (9.3547, -79.9017),     # Colon
    "PAPAN": (8.9833, -79.5167),     # Balboa
    "ZADUR": (-29.8587, 31.0218),    # Durban
    "ZACPT": (-33.9249, 18.4241),    # Cape Town
    "EGALY": (31.2001, 29.9187),     # Alexandria
    "EGPSD": (31.2653, 32.3019),     # Port Said
    "NGAPP": (6.5244, 3.3792),       # Lagos/Apapa
    "KEMBA": (-4.0589, 39.6696),     # Mombasa
    "MAPTM": (35.7595, -5.8340),     # Tanger Med
    "MACAS": (33.5731, -7.5898),     # Casablanca
    "NZAKL": (-36.8485, 174.7633),   # Auckland
    "NZLYT": (-43.6030, 172.7220),   # Lyttelton
}

DSN = "postgresql://neondb_owner:npg_FU7X4gicMjkn@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb"


async def main():
    conn = await asyncpg.connect(DSN)
    updated = 0
    for locode, (lat, lng) in COORDS.items():
        r = await conn.execute(
            "UPDATE market_ports SET lat=$1, lng=$2, updated_at=NOW() WHERE tenant_id='default' AND un_locode=$3",
            lat, lng, locode,
        )
        if "UPDATE 1" in r:
            updated += 1
    print(f"updated coords for {updated} ports")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
