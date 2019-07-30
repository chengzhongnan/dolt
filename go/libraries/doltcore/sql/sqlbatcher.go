package sql

import (
	"context"
	"errors"
	"fmt"
	"github.com/liquidata-inc/dolt/go/libraries/doltcore/doltdb"
	"github.com/liquidata-inc/dolt/go/libraries/doltcore/row"
	"github.com/liquidata-inc/dolt/go/libraries/doltcore/schema"
	"github.com/liquidata-inc/dolt/go/store/hash"
	"github.com/liquidata-inc/dolt/go/store/types"
)

var ErrKeyExists = errors.New("key already exists")

// SqlBatcher knows how to efficiently batch insert / update statements, e.g. when doing a SQL import. It does this by
// using a single MapEditor per table that isn't persisted until Commit is called.
type SqlBatcher struct {
	// The root value we are editing
	root *doltdb.RootValue
	// The set of tables under edit
	tables map[string]*doltdb.Table
	// The schemas of tables under edit
	schemas map[string]schema.Schema
	// The row data for tables being edited
	rowData map[string]types.Map
	// The editors applying updates to the tables
	editors map[string]*types.MapEditor
	// The hashes of primary keys being inserted to the tables
	hashes map[string]map[hash.Hash]bool
}

// Returns a new SqlBatcher for the given environment and root value.
func NewSqlBatcher(root *doltdb.RootValue) *SqlBatcher {
	return &SqlBatcher{
		root: root,
		tables: make(map[string]*doltdb.Table),
		rowData: make(map[string]types.Map),
		editors: make(map[string]*types.MapEditor),
		hashes: make(map[string]map[hash.Hash]bool),
	}
}

type InsertOptions struct {
	// Whether to silently replace any existing rows with the same primary key as rows inserted
	Replace bool
	// Whether to ignore primary key duplication. Unlike Replace, inserts for existing keys are simply ignored, not
	// updated.
	IgnoreExisting bool
}

type BatchInsertResult struct {
	RowInserted  bool
	RowUpdated   bool
}

func (b *SqlBatcher) Insert(ctx context.Context, tableName string, r row.Row, opt InsertOptions) (*BatchInsertResult, error) {
	sch, err := b.getSchema(ctx, tableName)
	if err != nil {
		return nil, err
	}

	rowData, err := b.getRowData(ctx, tableName)
	if err != nil {
		return nil, err
	}

	ed, err := b.getEditor(ctx, tableName)
	if err != nil {
		return nil, err
	}

	key := r.NomsMapKey(sch).Value(ctx)

	rowExists := rowData.Get(ctx, key) != nil
	hashes := b.getHashes(ctx, tableName)
	rowAlreadyTouched := hashes[key.Hash(b.root.VRW().Format())]

	if rowExists || rowAlreadyTouched {
		if !opt.Replace && !opt.IgnoreExisting {
			return nil, ErrKeyExists
		}

		// If Replace and IgnoreExisting are both set, favor Replace semantics
		if opt.Replace {
			// do nothing, continue to editing
		} else if opt.IgnoreExisting {
			return &BatchInsertResult{}, nil
		}
	}

	ed.Set(key, r.NomsMapValue(sch))
	hashes[key.Hash(b.root.VRW().Format())] = true

	return &BatchInsertResult{RowInserted: !rowExists, RowUpdated: rowExists || rowAlreadyTouched}, nil
}

func (b *SqlBatcher) getTable(ctx context.Context, tableName string) (*doltdb.Table, error) {
	if table, ok := b.tables[tableName]; ok {
		return table, nil
	}

	if !b.root.HasTable(ctx, tableName) {
		return nil, fmt.Errorf("Unknown table %v", tableName)
	}

	table, _ := b.root.GetTable(ctx, tableName)
	b.tables[tableName] = table
	return table, nil
}

func (b *SqlBatcher) getSchema(ctx context.Context, tableName string) (schema.Schema, error) {
	if schema, ok := b.schemas[tableName]; ok {
		return schema, nil
	}

	table, err := b.getTable(ctx, tableName)
	if err != nil {
		return nil, err
	}

	sch := table.GetSchema(ctx)
	b.schemas[tableName] = sch
	return sch,  nil
}

func (b *SqlBatcher) getEditor(ctx context.Context, tableName string) (*types.MapEditor, error) {
	if ed, ok := b.editors[tableName]; ok {
		return ed, nil
	}

	rowData, err := b.getRowData(ctx, tableName)
	if err != nil {
		return nil, err
	}

	ed := rowData.Edit()
	b.editors[tableName] = ed
	return ed, nil
}

func (b *SqlBatcher) getRowData(ctx context.Context, tableName string) (types.Map, error) {
	if rowData, ok := b.rowData[tableName]; ok {
		return rowData, nil
	}

	table, err := b.getTable(ctx, tableName)
	if err != nil {
		return types.EmptyMap, err
	}

	rowData := table.GetRowData(ctx)
	b.rowData[tableName] = rowData
	return rowData, nil
}

func (b *SqlBatcher) getHashes(ctx context.Context, tableName string) map[hash.Hash]bool {
	if hashes, ok := b.hashes[tableName]; ok {
		return hashes
	}

	hashes := make(map[hash.Hash]bool)
	b.hashes[tableName] = hashes
	return hashes
}

func (b *SqlBatcher) Update(r row.Row) {

}

func (b *SqlBatcher) Commit() (*doltdb.RootValue, error) {
	return nil, nil
}