"use client";

import { useEffect } from "react";
import { useLanguage } from "../context/LanguageContext";
import { APP_TEXT_TRANSLATIONS } from "../lib/appTextTranslations";

const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "SVG"]);

const reverseIndex = Object.fromEntries(
  Object.entries(APP_TEXT_TRANSLATIONS).map(([lang, map]) => [
    lang,
    Object.fromEntries(Object.entries(map).map(([fr, translated]) => [translated, fr])),
  ])
);

function toFrenchReference(text) {
  if (!text) return text;
  if (APP_TEXT_TRANSLATIONS.en[text] || APP_TEXT_TRANSLATIONS.es[text]) return text;
  return reverseIndex.en[text] || reverseIndex.es[text] || text;
}

function applyTranslation(originalText, language) {
  if (!originalText) return originalText;

  const frenchReference = toFrenchReference(originalText);

  if (language === "fr") {
    return frenchReference;
  }

  const targetMap = APP_TEXT_TRANSLATIONS[language] || {};
  if (targetMap[frenchReference]) return targetMap[frenchReference];

  let translated = frenchReference;
  for (const [source, target] of Object.entries(targetMap)) {
    if (translated.includes(source)) {
      translated = translated.replaceAll(source, target);
    }
  }

  return translated;
}

export default function AppTranslator() {
  const { language } = useLanguage();

  useEffect(() => {
    const textNodeOriginals = new WeakMap();

    const shouldSkipNode = (node) => {
      if (!node?.parentElement) return true;
      if (EXCLUDED_TAGS.has(node.parentElement.tagName)) return true;
      if (node.parentElement.closest("[data-no-translate='true']")) return true;
      return false;
    };

    const translateTextNode = (textNode) => {
      if (!textNode || !textNode.nodeValue || shouldSkipNode(textNode)) return;
      const trimmed = textNode.nodeValue.trim();
      if (!trimmed) return;

      if (!textNodeOriginals.has(textNode)) {
        textNodeOriginals.set(textNode, textNode.nodeValue);
      }

      const original = textNodeOriginals.get(textNode);
      textNode.nodeValue = applyTranslation(original, language);
    };

    const translateAttributes = (root = document) => {
      const nodes = root.querySelectorAll("input[placeholder], textarea[placeholder], [title], [aria-label]");
      nodes.forEach((node) => {
        ["placeholder", "title", "aria-label"].forEach((attr) => {
          const value = node.getAttribute(attr);
          if (!value) return;

          const sourceAttr = `data-original-${attr}`;
          if (!node.getAttribute(sourceAttr)) {
            node.setAttribute(sourceAttr, value);
          }

          node.setAttribute(attr, applyTranslation(node.getAttribute(sourceAttr), language));
        });
      });
    };

    const walkAndTranslate = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let current = walker.nextNode();
      while (current) {
        nodes.push(current);
        current = walker.nextNode();
      }
      nodes.forEach(translateTextNode);
      translateAttributes(root instanceof Document ? document : root);
    };

    walkAndTranslate(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          translateTextNode(mutation.target);
        }

        mutation.addedNodes.forEach((addedNode) => {
          if (addedNode.nodeType === Node.TEXT_NODE) {
            translateTextNode(addedNode);
          } else if (addedNode.nodeType === Node.ELEMENT_NODE) {
            walkAndTranslate(addedNode);
          }
        });
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => observer.disconnect();
  }, [language]);

  return null;
}
