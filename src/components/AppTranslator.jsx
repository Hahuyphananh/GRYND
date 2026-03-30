"use client";

import { useEffect, useRef } from "react";
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
  const textNodeOriginalsRef = useRef(new WeakMap());

  useEffect(() => {
    const textNodeOriginals = textNodeOriginalsRef.current;
    const pendingRoots = new Set();
    let rafId = null;

    const shouldSkipNode = (node) => {
      if (!node?.parentElement) return true;
      if (EXCLUDED_TAGS.has(node.parentElement.tagName)) return true;
      if (node.parentElement.closest("[data-no-translate='true']")) return true;
      return false;
    };

    const translateTextNode = (textNode) => {
      if (!textNode || !textNode.nodeValue || shouldSkipNode(textNode)) return;
      const currentValue = textNode.nodeValue;
      const trimmed = currentValue.trim();
      if (!trimmed) return;

      if (!textNodeOriginals.has(textNode)) {
        textNodeOriginals.set(textNode, currentValue);
      }

      const original = textNodeOriginals.get(textNode);
      const translated = applyTranslation(original, language);
      if (translated !== currentValue) {
        textNode.nodeValue = translated;
      }
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

          const translated = applyTranslation(node.getAttribute(sourceAttr), language);
          if (translated !== value) {
            node.setAttribute(attr, translated);
          }
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

    const flushQueue = () => {
      rafId = null;
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      roots.forEach((root) => walkAndTranslate(root));
    };

    const queueTranslate = (root) => {
      pendingRoots.add(root);
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(flushQueue);
    };

    queueTranslate(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((addedNode) => {
          if (addedNode.nodeType === Node.TEXT_NODE) {
            translateTextNode(addedNode);
          } else if (addedNode.nodeType === Node.ELEMENT_NODE) {
            queueTranslate(addedNode);
          }
        });
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [language]);

  return null;
}
