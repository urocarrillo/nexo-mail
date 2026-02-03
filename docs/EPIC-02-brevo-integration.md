# EPIC-02: Integración Brevo (Email Sequences)

> **Subagente:** Puede ejecutarse en PARALELO con EPIC-01 y EPIC-03
> **Dependencias:** Ninguna (es una librería standalone)
> **Output:** Módulo `/lib/brevo.ts` con todas las funciones de Brevo

---

## Contexto

Brevo (ex-Sendinblue) maneja las secuencias de email. Necesitamos:
1. Agregar contactos a listas según su TAG
2. Iniciar secuencias automáticas (Automation en Brevo)
3. Poder marcar contactos como compradores y detener secuencias

---

## User Stories

### US-2.1: Agregar contacto a Brevo
**Como** sistema  
**Quiero** crear/actualizar un contacto en Brevo con sus atributos  
**Para** que entre en el flujo de emails

### US-2.2: Asignar lista según TAG
**Como** sistema  
**Quiero** agregar el contacto a una lista específica según su TAG  
**Para** que reciba la secuencia correcta

### US-2.3: Marcar como comprador
**Como** sistema  
**Quiero** actualizar el atributo "COMPRADOR" del contacto  
**Para** que Brevo detenga las secuencias de venta

### US-2.4: Obtener estado de contacto
**Como** dashboard  
**Quiero** consultar el estado de un contacto en Brevo  
**Para** mostrar información actualizada

---

## Especificaciones Técnicas

### Configuración de Listas en Brevo

Crear estas listas manualmente en Brevo (Settings > Contacts > Lists):

| ID Lista | Nombre | TAG asociado |
|----------|--------|--------------|
| 1 | Lista General | `general` (default) |
| 2 | Lista Fitness | `reel-fitness` |
| 3 | Lista Nutricion | `reel-nutricion` |
| 4 | Lista Promo | `story-promo` |
| 5 | Compradores | (automático al comprar) |

### Atributos de Contacto en Brevo

Crear estos atributos en Brevo (Settings > Contacts > Attributes):

| Atributo | Tipo | Descripción |
|----------|------|-------------|
| NOMBRE | Text | Nombre del lead |
| TAG | Text | Tag de origen |
| ID_MANYCHAT | Text | ID de ManyChat |
| SOURCE | Text | Siempre "manychat-instagram" |
| COMPRADOR | Boolean | True cuando compra |
| FECHA_COMPRA | Date | Fecha de compra |

### Módulo Brevo

```typescript
// src/lib/brevo.ts

import * as SibApiV3Sdk from '@sendinblue/client';

// Inicializar cliente
const apiInstance = new SibApiV3Sdk.ContactsApi();
apiInstance.setApiKey(
  SibApiV3Sdk.ContactsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY!
);

// Mapeo TAG → Lista ID
const TAG_TO_LIST: Record<string, number> = {
  'general': 1,
  'reel-fitness': 2,
  'reel-nutricion': 3,
  'story-promo': 4,
};

const LISTA_COMPRADORES = 5;

// Interfaces
export interface CreateContactParams {
  email: string;
  nombre: string;
  tag: string;
  idContacto: string;
  source: string;
}

export interface ContactResult {
  id: number;
  email: string;
  listIds: number[];
  created: boolean;
}

export interface UpdateResult {
  success: boolean;
  message: string;
}

/**
 * Agregar o actualizar contacto en Brevo
 * - Crea el contacto si no existe
 * - Actualiza atributos si ya existe
 * - Agrega a la lista correspondiente según TAG
 */
export async function addContactToBrevo(
  params: CreateContactParams
): Promise<ContactResult> {
  const { email, nombre, tag, idContacto, source } = params;
  
  // Determinar lista según tag
  const listId = TAG_TO_LIST[tag] || TAG_TO_LIST['general'];
  
  // Preparar atributos
  const attributes = {
    NOMBRE: nombre,
    TAG: tag,
    ID_MANYCHAT: idContacto,
    SOURCE: source,
    COMPRADOR: false,
  };
  
  try {
    // Intentar crear contacto nuevo
    const createContact = new SibApiV3Sdk.CreateContact();
    createContact.email = email;
    createContact.attributes = attributes;
    createContact.listIds = [listId];
    createContact.updateEnabled = true; // Actualiza si ya existe
    
    const response = await apiInstance.createContact(createContact);
    
    console.log(`[BREVO] Contacto creado/actualizado: ${email}, lista: ${listId}`);
    
    return {
      id: response.body.id,
      email: email,
      listIds: [listId],
      created: true
    };
    
  } catch (error: any) {
    // Si el contacto ya existe, actualizar
    if (error.response?.statusCode === 400 && 
        error.response?.body?.message?.includes('already exist')) {
      
      return await updateExistingContact(email, attributes, listId);
    }
    
    console.error('[BREVO] Error creando contacto:', error);
    throw error;
  }
}

/**
 * Actualizar contacto existente
 */
async function updateExistingContact(
  email: string,
  attributes: Record<string, any>,
  listId: number
): Promise<ContactResult> {
  
  // Actualizar atributos
  const updateContact = new SibApiV3Sdk.UpdateContact();
  updateContact.attributes = attributes;
  updateContact.listIds = [listId];
  
  await apiInstance.updateContact(email, updateContact);
  
  // Obtener ID del contacto
  const contact = await apiInstance.getContactInfo(email);
  
  console.log(`[BREVO] Contacto actualizado: ${email}`);
  
  return {
    id: contact.body.id,
    email: email,
    listIds: contact.body.listIds || [listId],
    created: false
  };
}

/**
 * Marcar contacto como comprador
 * - Actualiza atributo COMPRADOR = true
 * - Agrega a lista de Compradores
 * - Esto dispara automáticamente la salida de secuencias de venta en Brevo
 */
export async function markAsPurchased(
  email: string,
  orderId?: string
): Promise<UpdateResult> {
  
  try {
    const updateContact = new SibApiV3Sdk.UpdateContact();
    updateContact.attributes = {
      COMPRADOR: true,
      FECHA_COMPRA: new Date().toISOString().split('T')[0],
      ORDER_ID: orderId || '',
    };
    updateContact.listIds = [LISTA_COMPRADORES];
    
    await apiInstance.updateContact(email, updateContact);
    
    console.log(`[BREVO] Contacto marcado como comprador: ${email}`);
    
    return {
      success: true,
      message: `Contact ${email} marked as purchased`
    };
    
  } catch (error: any) {
    console.error('[BREVO] Error marcando comprador:', error);
    
    // Si el contacto no existe, no es un error crítico
    if (error.response?.statusCode === 404) {
      return {
        success: false,
        message: `Contact ${email} not found in Brevo`
      };
    }
    
    throw error;
  }
}

/**
 * Obtener información de un contacto
 */
export async function getContact(email: string): Promise<{
  exists: boolean;
  contact?: {
    id: number;
    email: string;
    attributes: Record<string, any>;
    listIds: number[];
  };
}> {
  
  try {
    const response = await apiInstance.getContactInfo(email);
    
    return {
      exists: true,
      contact: {
        id: response.body.id,
        email: response.body.email,
        attributes: response.body.attributes || {},
        listIds: response.body.listIds || []
      }
    };
    
  } catch (error: any) {
    if (error.response?.statusCode === 404) {
      return { exists: false };
    }
    throw error;
  }
}

/**
 * Eliminar contacto de todas las listas (excepto compradores)
 * Útil para opt-out manual
 */
export async function removeFromSequences(email: string): Promise<UpdateResult> {
  
  try {
    const updateContact = new SibApiV3Sdk.UpdateContact();
    updateContact.unlinkListIds = [1, 2, 3, 4]; // Todas excepto compradores
    
    await apiInstance.updateContact(email, updateContact);
    
    return {
      success: true,
      message: `Contact ${email} removed from all sequences`
    };
    
  } catch (error) {
    console.error('[BREVO] Error removiendo de secuencias:', error);
    throw error;
  }
}

/**
 * Verificar que la API key funciona
 */
export async function testConnection(): Promise<boolean> {
  try {
    const accountApi = new SibApiV3Sdk.AccountApi();
    accountApi.setApiKey(
      SibApiV3Sdk.AccountApiApiKeys.apiKey,
      process.env.BREVO_API_KEY!
    );
    
    await accountApi.getAccount();
    return true;
  } catch {
    return false;
  }
}
```

### Configuración de Automations en Brevo

En Brevo, crear Automations (Automation > Create):

**Automation 1: Secuencia General**
- Trigger: Contact added to list "Lista General"
- Condición: COMPRADOR = false
- Acciones: Email 1 (delay 0) → Email 2 (delay 2 días)
- Exit: When COMPRADOR = true

**Automation 2: Secuencia Fitness**
- Trigger: Contact added to list "Lista Fitness"
- Condición: COMPRADOR = false
- Acciones: Email 1 → Email 2 → Email 3 (delays configurables)
- Exit: When COMPRADOR = true

*(Repetir para cada lista/secuencia)*

---

## Criterios de Aceptación

- [ ] `addContactToBrevo` crea contacto nuevo con atributos correctos
- [ ] `addContactToBrevo` actualiza contacto si ya existe (no duplica)
- [ ] `addContactToBrevo` asigna lista correcta según TAG
- [ ] `addContactToBrevo` usa Lista General si TAG no existe
- [ ] `markAsPurchased` actualiza COMPRADOR = true
- [ ] `markAsPurchased` agrega a Lista Compradores
- [ ] `markAsPurchased` no falla si contacto no existe (retorna success: false)
- [ ] `getContact` retorna datos completos del contacto
- [ ] `getContact` retorna exists: false si no existe
- [ ] `testConnection` valida que la API key funciona

---

## Tests

```typescript
// tests/brevo.test.ts

import {
  addContactToBrevo,
  markAsPurchased,
  getContact,
  testConnection
} from '@/lib/brevo';

describe('Brevo Integration', () => {
  
  const testEmail = `test-${Date.now()}@example.com`;
  
  test('testConnection valida API key', async () => {
    const result = await testConnection();
    expect(result).toBe(true);
  });
  
  test('addContactToBrevo crea contacto nuevo', async () => {
    const result = await addContactToBrevo({
      email: testEmail,
      nombre: 'Test User',
      tag: 'reel-fitness',
      idContacto: 'mc_test_123',
      source: 'manychat-instagram'
    });
    
    expect(result.email).toBe(testEmail);
    expect(result.listIds).toContain(2); // Lista Fitness
  });
  
  test('addContactToBrevo actualiza contacto existente', async () => {
    const result = await addContactToBrevo({
      email: testEmail,
      nombre: 'Test User Updated',
      tag: 'reel-nutricion', // Cambio de tag
      idContacto: 'mc_test_123',
      source: 'manychat-instagram'
    });
    
    expect(result.created).toBe(false);
    expect(result.listIds).toContain(3); // Lista Nutricion
  });
  
  test('addContactToBrevo usa lista general para tag desconocido', async () => {
    const unknownTagEmail = `test-unknown-${Date.now()}@example.com`;
    
    const result = await addContactToBrevo({
      email: unknownTagEmail,
      nombre: 'Test Unknown',
      tag: 'tag-que-no-existe',
      idContacto: 'mc_test_456',
      source: 'manychat-instagram'
    });
    
    expect(result.listIds).toContain(1); // Lista General
  });
  
  test('getContact retorna datos del contacto', async () => {
    const result = await getContact(testEmail);
    
    expect(result.exists).toBe(true);
    expect(result.contact?.email).toBe(testEmail);
    expect(result.contact?.attributes.NOMBRE).toBeDefined();
  });
  
  test('getContact retorna exists:false para email inexistente', async () => {
    const result = await getContact('noexiste@noexiste.com');
    expect(result.exists).toBe(false);
  });
  
  test('markAsPurchased actualiza atributos', async () => {
    const result = await markAsPurchased(testEmail, 'order_123');
    
    expect(result.success).toBe(true);
    
    // Verificar que se actualizó
    const contact = await getContact(testEmail);
    expect(contact.contact?.attributes.COMPRADOR).toBe(true);
    expect(contact.contact?.listIds).toContain(5); // Lista Compradores
  });
  
  test('markAsPurchased no falla con email inexistente', async () => {
    const result = await markAsPurchased('noexiste@noexiste.com');
    
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });
});
```

---

## Ralph Loop One-Shot

```
1. ✅ Leer esta épica completa
2. Instalar dependencia: npm install @sendinblue/client
3. Crear archivo src/lib/brevo.ts
4. Crear archivo tests/brevo.test.ts
5. Agregar BREVO_API_KEY a .env.local
6. Ejecutar: npm test -- brevo
7. Si FAIL → fix y volver a 6
8. Si PASS → EPIC-02 DONE ✅
```

---

## Configuración en Brevo (Manual)

### 1. Obtener API Key
- Brevo Dashboard > Settings > API Keys
- Crear nueva key con permisos de Contacts

### 2. Crear Listas
- Contacts > Lists > Create List
- Crear: Lista General, Lista Fitness, Lista Nutricion, Lista Promo, Compradores

### 3. Crear Atributos
- Contacts > Settings > Contact Attributes
- Crear: NOMBRE (text), TAG (text), ID_MANYCHAT (text), SOURCE (text), COMPRADOR (boolean), FECHA_COMPRA (date)

### 4. Crear Automations
- Automation > Create
- Trigger: "Contact added to list"
- Condición: COMPRADOR = false
- Exit condition: COMPRADOR = true
