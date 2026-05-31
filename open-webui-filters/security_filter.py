"""
title: Corporate CRM Security Filter
author: Yurii Khalus
version: 1.0.0
description: A filter to prevent prompt injection and inject the user's email into the context.
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any

class Filter:
    class Valves(BaseModel):
        # Додаткові налаштування, які адміністратор зможе змінювати в UI
        pass

    class UserValves(BaseModel):
        pass

    def __init__(self):
        self.valves = self.Valves()
        self.user_valves = self.UserValves()

    def inlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        """
        Метод inlet перехоплює запит до того, як він буде надісланий в LLM.
        """
        
        messages = body.get("messages", [])
        if not messages:
            return body
            
        last_message = messages[-1].get("content", "")
        
        # Лексичний аналіз на Prompt Injection
        forbidden_words = [
            "ignore all previous instructions",
            "ignore previous instructions",
            "system prompt",
            "bypass",
            "forget instructions",
            "disregard previous instructions"
        ]
        
        lower_content = last_message.lower()
        for word in forbidden_words:
            if word in lower_content:
                raise Exception(f"Security Alert: Підозра на Prompt Injection (виявлено стоп-фразу). Запит заблоковано.")
        
        # Автоматична ін'єкція Email користувача
        if __user__ and "email" in __user__:
            user_email = __user__["email"]
            
            if messages[-1]["role"] == "user":
                original_content = messages[-1]["content"]
                
                injected_context = f"\n\n[SYSTEM CONTEXT: The email of the current logged-in user is '{user_email}'. You MUST use this exact email for any tool or function parameters requiring a 'user_email'. Do NOT ask the user for their email, use this one.]"
                
                messages[-1]["content"] = original_content + injected_context
                body["messages"] = messages
                
        return body

    def outlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        """
        Метод outlet перехоплює відповідь LLM перед тим, як вона повернеться користувачу.
        """
        messages = body.get("messages", [])
        if messages:
            last_message = messages[-1].get("content", "")
            if "__PROMPT_INJECTION_DETECTED__" in last_message:
                raise Exception("Попередження безпеки: Шлюз штучного інтелекту виявив розширене впровадження запиту. Запит заблоковано.")
        
        return body
