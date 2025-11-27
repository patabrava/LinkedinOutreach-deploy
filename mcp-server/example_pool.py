"""Example pool manager for rotating through immobilien-specific examples."""

from __future__ import annotations

import random
from typing import Dict, List, Tuple

# Define the 5 categories of examples with structured data
EXAMPLE_CATEGORIES = {
    "PROZESS-AUTOMATISIERUNG": [
        "Exposé-Erstellung automatisiert – von 2 Stunden auf 10 Minuten, inklusive Formatierung",
        "Besichtigungskoordination läuft jetzt automatisch statt per E-Mail-Marathon",
        "Mietvertrags-Erstellung komplett automatisiert – von Template bis fertiges PDF in 5 Minuten",
        "Rechnungsstellung für 200+ Einheiten vollautomatisch, kein manuelles Copy-Paste mehr",
    ],
    "DATA & CRM": [
        "voll funktionsfähiges Objekt-CRM in 5 Stunden gebaut, weil ich keine Lust mehr auf Excel-Chaos hatte",
        "Lead-Scoring automatisiert – System priorisiert Kaufinteressenten nach Conversion-Wahrscheinlichkeit",
        "Mieter-Kommunikation zentralisiert – WhatsApp, E-Mail, Portal in einem Dashboard",
        "Portfolio-Reporting läuft Freitags automatisch, statt 4 Stunden Excel-Jonglage",
    ],
    "MARKETING & CONTENT": [
        "Social-Media-Posts für alle Neuzugänge automatisch generiert und geplant",
        "Objekt-Beschreibungen per KI in 3 Sprachen, spart 90% der Zeit",
        "Virtuelle Rundgänge direkt aus Floor-Plans erstellt – ohne Agentur",
        "Marktanalyse-Reports automatisch wöchentlich, statt manuell zusammenklicken",
    ],
    "DOKUMENTE & COMPLIANCE": [
        "Energieausweise, Grundrisse, Nachweise automatisch in Objekt-Akte sortiert",
        "Mieterhöhungs-Prozess standardisiert – von Kalkulation bis Anschreiben in 15 Minuten",
        "Betriebskosten-Abrechnung für 150 Einheiten in 2 Stunden statt 3 Tagen",
        "DSGVO-konforme Dokumenten-Archivierung ohne manuelle Sortierung",
    ],
    "TEAM & KOORDINATION": [
        "Instandhaltungs-Tickets automatisch an Handwerker verteilt, mit Tracking",
        "Onboarding neuer Objekte läuft als Workflow – Checkliste, Fotos, Daten in einem System",
        "Besichtigungs-Feedback direkt ins CRM, Team sieht Echtzeit-Status",
    ],
}

# Rotation order for categories
CATEGORY_ROTATION = [
    "PROZESS-AUTOMATISIERUNG",
    "DATA & CRM",
    "MARKETING & CONTENT",
    "DOKUMENTE & COMPLIANCE",
    "TEAM & KOORDINATION",
]


class ExamplePool:
    """Manages rotation through example categories."""
    
    def __init__(self):
        self.categories = EXAMPLE_CATEGORIES
        self.rotation_order = CATEGORY_ROTATION
    
    def get_next_category_index(self, current_index: int | None) -> int:
        """Get the next category index using round-robin rotation."""
        if current_index is None:
            return 0
        return (current_index + 1) % len(self.rotation_order)
    
    def select_example(self, category_index: int) -> Tuple[str, str, int]:
        """
        Select a random example from the given category.
        
        Returns:
            Tuple of (category_name, example_text, category_index)
        """
        category_name = self.rotation_order[category_index]
        examples = self.categories[category_name]
        selected_example = random.choice(examples)
        
        return category_name, selected_example, category_index
    
    def get_next_example(self, last_category_index: int | None) -> Tuple[str, str, int]:
        """
        Get the next example using round-robin category rotation.
        
        Args:
            last_category_index: The index of the last used category (None if first time)
        
        Returns:
            Tuple of (category_name, example_text, new_category_index)
        """
        next_index = self.get_next_category_index(last_category_index)
        return self.select_example(next_index)


def get_example_pool() -> ExamplePool:
    """Factory function to get an ExamplePool instance."""
    return ExamplePool()
