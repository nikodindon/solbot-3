/// <reference types="vite/client" />

/**
 * Déclarations pour les imports CSS.
 *
 * Vite gère les CSS nativement ; TypeScript a besoin d'une déclaration pour
 * accepter les imports « side-effect ».
 */
declare module "*.css";
